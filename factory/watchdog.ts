import type { PluginTools, ThreadID } from "@ampcode/plugin";
import { createHash } from "node:crypto";
import { lastFire, shortestGapMinutes } from "./cron";
import {
  automationEnabled,
  providerResetAt,
  type State,
  type Task,
} from "./persistence";

// The longest the one clock waits: the watchdog's own period. Automations only shorten it.
const watchdogMinutes = 30;

function recurrence(minutes: number) {
  return `RRULE:FREQ=MINUTELY;INTERVAL=${minutes}`;
}

type Automations = State["automations"];

function enabledAutomations(automations: Automations) {
  return Object.values(automations ?? {}).filter(automationEnabled);
}

// The clock runs while the factory is started and has work or an enabled automation.
function wantsClock(state: State, queue: Task[], automations: Automations) {
  return (
    state.enabled &&
    (enabledAutomations(automations).length > 0 ||
      queue.some(
        (task) =>
          (task.intake !== "planned" || Object.hasOwn(state.runs, task.id)) &&
          state.runs[task.id]?.kind !== "done",
      ))
  );
}

// The clock's period: the shortest any enabled automation needs, never longer than the watchdog's.
function clockMinutes(automations: Automations) {
  return Math.min(
    watchdogMinutes,
    ...enabledAutomations(automations).map((record) =>
      shortestGapMinutes(record.schedule),
    ),
  );
}

/** Names of enabled automations whose latest scheduled minute at or before `at` is not before the
 * time they were armed and is later than their last run. However many wakes were missed, that is
 * one name once; a send that was recorded, even with an unknown outcome, is never due again.
 */
export function dueAutomations(state: State, at: number) {
  return Object.entries(state.automations ?? {})
    .filter(([, record]) => {
      if (!automationEnabled(record)) return false;
      const fire = lastFire(record.schedule, at);
      return (
        fire !== undefined &&
        fire >= record.armedAt &&
        (record.lastRunAt === undefined || fire > record.lastRunAt)
      );
    })
    .map(([name]) => name);
}

/** Standing rules for the observer thread; its schedule prompt repeats them on every wake. */
export const observerInstructions =
  "You are the factory observer. Use only the factory control actions reconcile and status-summary, and send_thread_message to the owner thread named in the summary. On every wake or message, call reconcile, then status-summary, and compare it with the last summary in this thread. Send the owner one short message only when a run has a new incident ID, a higher attempt (a rejection or a resume) or newly became done (accepted), when the summary's due list holds an id you have not reported before in this thread, or when you received a Factory suspicion message about stale lifecycle progress. Report each due id exactly once, even if it stays listed on later wakes. Any other change of kind or stage, such as building to reviewing, is routine progress. Otherwise end your turn without any message. Never call any other factory action, never retry an action that failed, and never claim permission; the owner does every due item and decides every recovery.";

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

function schedulePrompt(title: string, root: string, observer: boolean) {
  return observer
    ? `${title}. Factory root: ${root}. ${observerInstructions}`
    : `${title}. Factory root: ${root}. Read factory status and match this fingerprint to durable monitor state before acting. Use the supported factory reconcile action in this connected owner thread. Diagnose current incidents against private evidence and worker activity; use only the supported exact-incident recovery action after resolving its cause. For resume supply ticket, current incident ID and diagnosis decision; paused factories stay paused. Running or unknown activity retains the same worker. Never blindly resume, grant permission, replace a worker, accept code or retry an uncertain remote effect. Inspect actual schedule state after ambiguous create or clear; held sending/unknown alert reservations are not retry instructions. Do not separately notify for a reserved intent. Preserve unrelated schedules and second roots. Normal gates and cold review still apply. Report the current incident and next safe action briefly, or give one short no-change update. This wake grants no permission. The factory source's factory/config/agents/foreman/agent.md Saved watchdog turn section has further operating guidance; it need not exist in the managed repository.`;
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
      throw new Error("Schedule target does not match the inspected thread");
    return schedule;
  } catch (error) {
    throw new WatchdogUnavailable(
      `Watchdog inspection failed: ${String(error)}`,
    );
  }
}

// The period of a plain minutely recurrence this factory could have installed (1 to 30 minutes),
// or undefined for any other shape.
function recurrenceMinutes(value: unknown) {
  if (typeof value !== "string") return;
  const rules = value
    .split(/\r?\n/)
    .filter((line) => line.startsWith("RRULE:"));
  if (rules.length !== 1) return;
  const fields = new URLSearchParams(rules[0]!.slice(6).replaceAll(";", "&"));
  const minutes = Number(fields.get("INTERVAL"));
  return [...fields.keys()].length === 2 &&
    fields.get("FREQ") === "MINUTELY" &&
    Number.isInteger(minutes) &&
    minutes > 0 &&
    minutes <= watchdogMinutes
    ? minutes
    : undefined;
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

// The period of an enabled existing-thread registration, or undefined when its shape drifted.
function ownedMinutes(current: Record<string, unknown>) {
  const trigger = current.trigger as { schedule?: unknown } | undefined;
  return current.runMode === "existing" && current.enabled === true
    ? recurrenceMinutes(trigger?.schedule)
    : undefined;
}

// Whether the registration's anchor is the wanted one. Without a wanted anchor, the last confirmed
// one still in the registration means a change that never applied.
function anchored(schedule: string, wakeAt?: number, staleWake?: unknown) {
  if (wakeAt === undefined && typeof staleWake === "number")
    return !matchingAnchor(schedule, staleWake);
  return matchingAnchor(schedule, wakeAt);
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
  const minutes = ownedMinutes(current);
  if (minutes === undefined) return "drifted";
  // Another period is this factory's own registration to retime, like a stale anchor.
  return minutes === Number(expected.interval ?? watchdogMinutes) &&
    anchored(trigger!.schedule as string, wakeAt, expected.staleWake)
    ? "owned"
    : "unanchored";
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
  wakeAt: number | undefined,
  target: ThreadID | undefined,
) {
  // Omitting the thread keeps the owner's own registration call exactly as observed.
  const thread = target ? { thread: target } : {};
  const minutes = Number(expected.interval);
  await tools
    .call(
      wanted ? "amp.set_schedule" : "amp.clear_schedule",
      wanted
        ? {
            title: expected.title,
            prompt: expected.prompt,
            schedule:
              wakeAt === undefined
                ? recurrence(minutes)
                : `${anchor(wakeAt)}\n${recurrence(minutes)}`,
            schedule_label:
              wakeAt === undefined
                ? `Every ${minutes} minutes`
                : `Provider reset, then every ${minutes} minutes`,
            run_mode: "existing",
            ...thread,
          }
        : thread,
    )
    .catch(() => undefined);
  // A lost acknowledgment is not a failed effect. Inspect before deciding anything else.
  return registration(await readSchedule(tools, target), expected, wakeAt);
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
  if (!notificationCapacity(monitor, at)) return;
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

/** Clear this factory's registration on another thread and confirm it by read-back.
 * @throws WatchdogUnavailable when the clear is unconfirmed.
 */
export async function removePreviousSchedule(
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

// With an observer registered the owner's own registration is stale. Every connected owner
// reconcile clears it by read-back after the observer's state is confirmed, so a failed or
// interrupted cleanup is retried and its problem stays until the clear is confirmed.
async function clearOwnerSchedule(
  state: State,
  tools: PluginTools,
  fingerprint: string,
) {
  const observer = state.foreman?.observer?.thread;
  if (observer && state.owner && state.owner !== observer)
    await removePreviousSchedule(tools, state.owner, fingerprint);
}

/** Reconcile only this factory's existing-thread schedule under the lifecycle lock. The schedule
 * wakes the registered observer thread when there is one, and the connected owner otherwise.
 * `automations` is the snapshot the clock is fitted to; a first start passes the one it is about
 * to accept, before it is saved.
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
  automations: Automations = state.automations,
) {
  if (!tools) return;
  const fingerprint = watchdogFingerprint(root, directory);
  const monitor = monitorState(state, fingerprint, thread, save);
  const observer = state.foreman?.observer?.thread;
  const title = `Factory watchdog ${fingerprint}`;
  const prompt = schedulePrompt(title, root, !!observer);
  const wanted = wantsClock(state, queue, automations);
  const expected = {
    fingerprint,
    title,
    prompt,
    interval: clockMinutes(automations),
    staleWake: monitor.wakeAt,
  };
  const settled = wanted ? "installed" : "cleared";
  const resets = Object.values(state.runs).flatMap((run) => {
    const limit = run.kind !== "done" ? run.incident?.providerLimit : undefined;
    if (!limit || limit.continuation) return [];
    const due = providerResetAt(limit);
    return due > at ? [due + 60_000] : [];
  });
  // An enabled automation needs wakes before any reset, so it keeps the schedule unanchored; the
  // continuation stays gated by its own reset time at whichever wake follows it.
  const wakeAt =
    resets.length && !enabledAutomations(automations).length
      ? Math.min(...resets)
      : undefined;
  try {
    await clearPreviousOwners(state, tools, save, at);
    if (state.enabled && !execute) return;
    const current = registration(
      await readSchedule(tools, observer),
      expected,
      wakeAt,
    );
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
      await clearOwnerSchedule(state, tools, fingerprint);
      settleMonitor(monitor, settled, save);
      return;
    }
    monitor.schedule = "checking";
    monitor.pendingThread = thread;
    save();
    // SQLite intent is not a remote receipt. Always inspect, even after a successful call.
    if (
      !satisfied(
        await changeRegistration(tools, expected, wanted, wakeAt, observer),
        wanted,
      )
    )
      throw new WatchdogUnavailable(
        "Watchdog effect not confirmed; inspect actual schedule before another action",
      );
    monitor.wakeAt = wakeAt;
    await clearOwnerSchedule(state, tools, fingerprint);
    settleMonitor(monitor, settled, save);
  } catch (error) {
    if (monitor.schedule !== "conflict") monitor.schedule = "unknown";
    save();
    throw error;
  }
}

// The rolling hourly notification budget; delivery and the due list share it.
function notificationCapacity(
  monitor: NonNullable<State["monitor"]>,
  at: number,
) {
  return (
    monitor.notifications.filter((delivery) => at - delivery.at < 3_600_000)
      .length < 10
  );
}

/** Alert intents the connected owner's reconcile would deliver at `at`. A held sending or unknown
 * reservation is never due, and nothing is due while the hourly budget is spent. `due` names the
 * escalation: it includes the latest reservation time, so an alert left over when the budget ran
 * out gets a fresh id once capacity returns.
 */
export function dueAlerts(state: State, at: number) {
  const monitor = state.monitor;
  if (!state.enabled || monitor?.schedule !== "installed") return [];
  if (!notificationCapacity(monitor, at)) return [];
  const latest = Math.max(0, ...monitor.notifications.map((sent) => sent.at));
  return Object.entries(state.runs).flatMap(([ticket, run]) =>
    run.kind === "done"
      ? []
      : (run.watchdog?.alerts ?? [])
          .filter(
            (alert) =>
              alert.acknowledgedAt === undefined &&
              !monitor.notifications.some((sent) => sent.id === alert.id),
          )
          .map((alert) => ({ ticket, alert, due: `${alert.id}:${latest}` })),
  );
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
  if (!tools || !execute) return;
  for (const { ticket, alert } of dueAlerts(state, now())) {
    await sendNotification(
      state.monitor!,
      tools,
      {
        id: alert.id,
        title: "Factory needs diagnosis",
        body: `Ticket ${ticket.slice(0, 80)}, attempt ${alert.attempt}. ${alert.kind === "parked" ? "Repair attempt cap reached; ticket parked" : alert.kind === "spending" ? "Repeated repair spending" : "No lifecycle progress"}. Incident ${alert.episode}. Read factory status and private evidence; this alert grants no permission.`.slice(
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
