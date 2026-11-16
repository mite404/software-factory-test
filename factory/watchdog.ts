import type { PluginTools, ThreadID } from "@ampcode/plugin";
import { createHash } from "node:crypto";
import type { State, Task } from "./persistence";

const recurrence = "RRULE:FREQ=MINUTELY;INTERVAL=30";

/** Stable identity of this factory at its original root and Git storage paths. */
export function watchdogFingerprint(root: string, directory: string) {
  return createHash("sha256")
    .update(`software-factory-watchdog-v1\0${root}\0${directory}`)
    .digest("hex");
}

function anchor(at: number) {
  return `DTSTART:${new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
}

/** Registration could not be confirmed; unlike persistence failures, owner control can continue. */
export class WatchdogUnavailable extends Error {}

function scheduleRecord(raw: unknown): Record<string, unknown> | null {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Unrecognized schedule result; inspect the connected tool bridge",
    );
  const result = value as Record<string, unknown>;
  if (typeof result.prompt !== "string" || typeof result.title !== "string")
    throw new Error("Unrecognized schedule fields");
  return result;
}

async function readSchedule(tools: PluginTools, thread?: ThreadID) {
  try {
    const schedule = scheduleRecord(
      await tools.call("amp.get_schedule", thread ? { thread } : {}),
    );
    if (thread && schedule && schedule.targetThreadID !== thread)
      throw new Error("Schedule target does not match the previous owner");
    return schedule;
  } catch (error) {
    throw new WatchdogUnavailable(
      `Watchdog inspection failed: ${String(error)}`,
    );
  }
}

function matchingRecurrence(value: unknown) {
  if (typeof value !== "string") return false;
  const rules = value
    .split(/\r?\n/)
    .filter((line) => line.startsWith("RRULE:"));
  if (rules.length !== 1) return false;
  const fields = new URLSearchParams(rules[0]!.slice(6).replaceAll(";", "&"));
  return (
    [...fields.keys()].length === 2 &&
    fields.get("FREQ") === "MINUTELY" &&
    Number(fields.get("INTERVAL")) === 30
  );
}

function matchingAnchor(schedule: string, wakeAt: number | undefined) {
  if (wakeAt === undefined) return true;
  const lines = schedule.split(/\r?\n/);
  if (lines.includes(anchor(wakeAt))) return true;
  const zoned = /^DTSTART;TZID=([^:\r\n]+):(\d{8}T\d{6})\r?$/m.exec(schedule);
  if (!zoned) return false;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zoned[1],
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(wakeAt)
        .map(({ type, value }) => [type, value]),
    );
    return (
      zoned[2] ===
      `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`
    );
  } catch {
    return false;
  }
}

function registration(
  current: Record<string, unknown> | null,
  expected: Record<string, unknown>,
  wakeAt?: number,
) {
  if (current === null) return "missing";
  const marker = String(expected.fingerprint);
  if (
    ![current.title, current.prompt].some((value) =>
      String(value).includes(marker),
    )
  )
    return "conflict";
  const trigger = current.trigger as { schedule?: unknown } | undefined;
  return matchingRecurrence(trigger?.schedule) &&
    current.runMode === "existing" &&
    current.enabled === true
    ? matchingAnchor(trigger!.schedule as string, wakeAt)
      ? "owned"
      : "unanchored"
    : "drifted";
}

function satisfied(
  current: ReturnType<typeof registration>,
  wanted: boolean,
  actualWake?: number,
  expectedWake?: number,
) {
  return wanted
    ? current === "owned" && actualWake === expectedWake
    : ["missing", "conflict"].includes(current);
}

function monitorState(
  state: State,
  fingerprint: string,
  thread: ThreadID | undefined,
  save: () => void,
) {
  if (state.monitor && state.monitor.fingerprint !== fingerprint) {
    state.monitor.schedule = "conflict";
    save();
    throw new WatchdogUnavailable(
      "Watchdog factory/root fingerprint changed; inspect ownership",
    );
  }
  state.monitor ??= { fingerprint, schedule: "checking", notifications: [] };
  const monitor = state.monitor;
  if (monitor.pendingThread && monitor.pendingThread !== thread) {
    monitor.schedule = "unknown";
    save();
    throw new WatchdogUnavailable(
      `Inspect uncertain watchdog effect on ${monitor.pendingThread} before changing threads`,
    );
  }
  return monitor;
}

async function changeRegistration(
  tools: PluginTools,
  expected: Record<string, unknown>,
  wanted: boolean,
  wakeAt?: number,
) {
  await tools
    .call(
      wanted ? "amp.set_schedule" : "amp.clear_schedule",
      wanted
        ? {
            title: expected.title,
            prompt: expected.prompt,
            schedule:
              wakeAt === undefined
                ? recurrence
                : `${anchor(wakeAt)}\n${recurrence}`,
            schedule_label:
              wakeAt === undefined
                ? "Every 30 minutes"
                : "Provider reset, then every 30 minutes",
            run_mode: "existing",
          }
        : {},
    )
    .catch(() => undefined);
  // A lost acknowledgment is not a failed effect. Inspect before deciding anything else.
  return registration(await readSchedule(tools), expected, wakeAt);
}

async function sendNotification(
  monitor: NonNullable<State["monitor"]>,
  tools: PluginTools,
  notice: { id: string; title: string; body: string },
  now: () => number,
  save: () => void,
  acknowledge = () => {},
) {
  if (monitor.notifications.some((delivery) => delivery.id === notice.id))
    return;
  const at = now();
  if (
    monitor.notifications.filter((delivery) => at - delivery.at < 3_600_000)
      .length >= 10
  )
    return;
  const delivery = {
    id: notice.id,
    at,
    outcome: "sending" as "sending" | "sent" | "unknown",
  };
  monitor.notifications.push(delivery);
  save();
  try {
    await tools.call("amp.notify_user", {
      title: notice.title,
      body: notice.body,
    });
  } catch {
    delivery.outcome = "unknown";
    save();
    return;
  }
  delivery.outcome = "sent";
  acknowledge();
  save();
}

function clearReceipt(raw: unknown) {
  const reply: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (
    !reply ||
    typeof reply !== "object" ||
    !("deleted" in reply) ||
    reply.deleted !== true
  )
    throw new Error("Unrecognized schedule clear result");
}

async function removePreviousSchedule(
  tools: PluginTools,
  thread: ThreadID,
  fingerprint: string,
) {
  const expected = { fingerprint };
  const previous = registration(await readSchedule(tools, thread), expected);
  if (previous === "missing" || previous === "conflict") return;
  let problem: string | undefined;
  try {
    clearReceipt(await tools.call("amp.clear_schedule", { thread }));
  } catch (error) {
    problem = String(error);
  }
  const current = registration(await readSchedule(tools, thread), expected);
  if (problem || (current !== "missing" && current !== "conflict"))
    throw new WatchdogUnavailable(
      ["Previous owner's watchdog clear is unconfirmed", problem]
        .filter(Boolean)
        .join(": "),
    );
}

async function clearPreviousOwner(
  state: State,
  handoff: NonNullable<State["foreman"]>["handoffs"][number],
  tools: PluginTools,
  save: () => void,
) {
  let problem: string | undefined;
  try {
    await removePreviousSchedule(
      tools,
      handoff.from,
      state.monitor!.fingerprint,
    );
  } catch (error) {
    problem = String(error);
  }
  const clear = problem === undefined ? "cleared" : "unreachable";
  const changed = state.foreman!.handoffs.filter(
    (previous) =>
      previous.from === handoff.from &&
      previous.clear !== "cleared" &&
      (previous.clear !== clear || previous.problem !== problem),
  );
  for (const previous of changed) {
    previous.clear = clear;
    if (problem === undefined) delete previous.problem;
    else previous.problem = problem;
  }
  if (changed.length) save();
  return changed.length > 0;
}

async function clearPreviousOwners(
  state: State,
  tools: PluginTools,
  save: () => void,
  at: number,
) {
  const monitor = state.monitor!;
  for (const [index, handoff] of (state.foreman?.handoffs ?? []).entries()) {
    // Hand-back makes this registration the current owner's wake, not stale cleanup.
    if (handoff.clear === "cleared" || handoff.from === state.owner) continue;
    const changed = await clearPreviousOwner(state, handoff, tools, save);
    if (!changed || handoff.clear !== "unreachable") continue;
    await sendNotification(
      monitor,
      tools,
      {
        id: `handoff-${index}`,
        title: "Factory watchdog cleanup unconfirmed",
        body: "The previous Foreman's watchdog clear could not be confirmed. New-owner registration proceeds independently. Read factory status for the handoff problem. Connected reconciles retry cleanup; do not clear unrelated schedules.",
      },
      () => at,
      save,
    );
  }
}

function settleMonitor(
  monitor: NonNullable<State["monitor"]>,
  schedule: "installed" | "cleared",
  save: () => void,
) {
  if (
    monitor.schedule === schedule &&
    monitor.pendingThread === undefined &&
    monitor.problem === undefined
  )
    return;
  monitor.schedule = schedule;
  delete monitor.pendingThread;
  delete monitor.problem;
  save();
}

/** Reconcile only this factory's existing-thread schedule under the lifecycle lock.
 * @throws On conflict, unavailable inspection, or an unconfirmed remote effect.
 */
export async function reconcileSchedule(
  root: string,
  directory: string,
  state: State,
  queue: Task[],
  tools: PluginTools | undefined,
  save: () => void,
  execute = true,
  thread: ThreadID | undefined = state.owner,
  at = Date.now(),
) {
  if (!tools) return;
  const fingerprint = watchdogFingerprint(root, directory);
  const monitor = monitorState(state, fingerprint, thread, save);
  const title = `Factory watchdog ${fingerprint}`;
  const prompt = `${title}. Factory root: ${root}. Read factory status and match this fingerprint to durable monitor state before acting. Use the supported factory reconcile action in this connected owner thread. Diagnose current incidents against private evidence and worker activity; use only the supported exact-incident recovery action after resolving its cause. For resume supply ticket, current incident ID and diagnosis decision; paused factories stay paused. Running or unknown activity retains the same worker. Never blindly resume, grant permission, replace a worker, accept code or retry an uncertain remote effect. Inspect actual schedule state after ambiguous create or clear; held sending/unknown alert reservations are not retry instructions. Do not separately notify for a reserved intent. Preserve unrelated schedules and second roots. Normal gates and cold review still apply. Report the current incident and next safe action briefly, or give one short no-change update. This wake grants no permission. The factory source's foreman.md Saved watchdog turn section has further operating guidance; it need not exist in the managed repository.`;
  const wanted =
    state.enabled &&
    queue.some(
      (task) =>
        (task.intake !== "planned" || Object.hasOwn(state.runs, task.id)) &&
        state.runs[task.id]?.kind !== "done",
    );
  const expected = {
    fingerprint,
    title,
    prompt,
  };
  const settled = wanted ? "installed" : "cleared";
  const resets = Object.values(state.runs).flatMap((run) => {
    const limit = run.kind !== "done" ? run.incident?.providerLimit : undefined;
    if (!limit || limit.continuation) return [];
    const due =
      limit.resetAt === undefined
        ? limit.observedAt + 1_800_000
        : limit.resetAt;
    return due > at ? [due + 60_000] : [];
  });
  const wakeAt = resets.length ? Math.min(...resets) : undefined;
  try {
    await clearPreviousOwners(state, tools, save, at);
    if (state.enabled && !execute) return;
    const current = registration(await readSchedule(tools), expected, wakeAt);
    if (current === "conflict" && wanted) {
      monitor.schedule = "conflict";
      delete monitor.pendingThread;
      throw new WatchdogUnavailable(
        "Thread already has an unrelated schedule or a second factory root; preserve it",
      );
    }
    if (current === "drifted" && wanted)
      throw new WatchdogUnavailable(
        "Owned watchdog configuration drifted; inspect recurrence, run mode and enabled state",
      );
    if (satisfied(current, wanted, monitor.wakeAt, wakeAt)) {
      settleMonitor(monitor, settled, save);
      return;
    }
    monitor.schedule = "checking";
    monitor.pendingThread = thread;
    save();
    // SQLite intent is not a remote receipt. Always inspect, even after a successful call.
    if (
      !satisfied(
        await changeRegistration(tools, expected, wanted, wakeAt),
        wanted,
      )
    )
      throw new WatchdogUnavailable(
        "Watchdog effect not confirmed; inspect actual schedule before another action",
      );
    monitor.wakeAt = wakeAt;
    settleMonitor(monitor, settled, save);
  } catch (error) {
    if (monitor.schedule !== "conflict") monitor.schedule = "unknown";
    save();
    throw error;
  }
}

/** Deliver durable alert intents only through the connected owner, reserving before sending.
 * Unknown sends stay held because Amp exposes no notification receipt lookup here.
 * @throws On failed persistence. Remote failures remain visible in durable state.
 */
export async function deliverAlerts(
  state: State,
  tools: PluginTools | undefined,
  now: () => number,
  save: () => void,
  execute = true,
) {
  const monitor = state.monitor;
  if (!tools || !execute) return;
  if (!state.enabled || monitor?.schedule !== "installed") return;
  const pending = Object.entries(state.runs).flatMap(([ticket, run]) =>
    run.kind === "done"
      ? []
      : (run.watchdog?.alerts ?? []).map((alert) => ({ ticket, alert })),
  );
  for (const { ticket, alert } of pending) {
    if (alert.acknowledgedAt !== undefined) continue;
    await sendNotification(
      monitor,
      tools,
      {
        id: alert.id,
        title: "Factory needs diagnosis",
        body: `Ticket ${ticket.slice(0, 80)}, attempt ${alert.attempt}. ${alert.kind === "spending" ? "Repeated repair spending" : "No lifecycle progress"}. Incident ${alert.episode}. Read factory status and private evidence; this alert grants no permission.`.slice(
          0,
          300,
        ),
      },
      now,
      save,
      () => {
        alert.acknowledgedAt = now();
      },
    );
  }
}
