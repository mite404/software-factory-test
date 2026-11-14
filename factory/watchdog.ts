import type { PluginTools, ThreadID } from "@ampcode/plugin";
import { createHash } from "node:crypto";
import type { State, Task } from "./persistence";

const recurrence = "RRULE:FREQ=MINUTELY;INTERVAL=30";

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

async function readSchedule(tools: PluginTools) {
  try {
    return scheduleRecord(await tools.call("amp.get_schedule", {}));
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

function registration(
  current: Record<string, unknown> | null,
  expected: Record<string, unknown>,
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
    ? "owned"
    : "drifted";
}

function satisfied(current: ReturnType<typeof registration>, wanted: boolean) {
  return wanted
    ? current === "owned"
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
) {
  await tools
    .call(
      wanted ? "amp.set_schedule" : "amp.clear_schedule",
      wanted
        ? {
            title: expected.title,
            prompt: expected.prompt,
            schedule: recurrence,
            schedule_label: "Every 30 minutes",
            run_mode: "existing",
          }
        : {},
    )
    .catch(() => undefined);
  // A lost acknowledgment is not a failed effect. Inspect before deciding anything else.
  return registration(await readSchedule(tools), expected);
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
) {
  if (!tools || (state.enabled && !execute)) return;
  const fingerprint = createHash("sha256")
    .update(`software-factory-watchdog-v1\0${root}\0${directory}`)
    .digest("hex");
  const monitor = monitorState(state, fingerprint, thread, save);
  const title = `Factory watchdog ${fingerprint}`;
  const prompt = `${title}. Factory root: ${root}. Read factory status and match this fingerprint to durable monitor state before acting. Use the supported factory reconcile action in this connected owner thread. Diagnose current incidents against private evidence and worker activity; use only the supported exact-incident recovery action after resolving its cause. For resume supply ticket, current incident ID and diagnosis decision; paused factories stay paused. Running or unknown activity retains the same worker. Never blindly resume, grant permission, replace a worker, accept code or retry an uncertain remote effect. Inspect actual schedule state after ambiguous create or clear; held sending/unknown alert reservations are not retry instructions. Do not separately notify for a reserved intent. Preserve unrelated schedules and second roots. Normal gates and cold review still apply. Report the current incident and next safe action briefly, or give one short no-change update. This wake grants no permission. The factory source's foreman.md Saved watchdog turn section has further operating guidance; it need not exist in the managed repository.`;
  const wanted =
    state.enabled && queue.some((task) => state.runs[task.id]?.kind !== "done");
  const expected = {
    fingerprint,
    title,
    prompt,
  };
  const settled = wanted ? "installed" : "cleared";
  try {
    const current = registration(await readSchedule(tools), expected);
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
    if (satisfied(current, wanted)) {
      monitor.schedule = settled;
      delete monitor.pendingThread;
      delete monitor.problem;
      save();
      return;
    }
    monitor.schedule = "checking";
    monitor.pendingThread = thread;
    save();
    // SQLite intent is not a remote receipt. Always inspect, even after a successful call.
    if (!satisfied(await changeRegistration(tools, expected, wanted), wanted))
      throw new WatchdogUnavailable(
        "Watchdog effect not confirmed; inspect actual schedule before another action",
      );
    monitor.schedule = settled;
    delete monitor.pendingThread;
    delete monitor.problem;
    save();
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
    if (
      alert.acknowledgedAt !== undefined ||
      monitor.notifications.some((delivery) => delivery.id === alert.id)
    )
      continue;
    const at = now();
    if (
      monitor.notifications.filter((delivery) => at - delivery.at < 3_600_000)
        .length >= 10
    )
      return;
    const delivery = {
      id: alert.id,
      at,
      outcome: "sending" as "sending" | "sent" | "unknown",
    };
    monitor.notifications.push(delivery);
    save();
    try {
      await tools.call("amp.notify_user", {
        title: "Factory needs diagnosis",
        body: `Ticket ${ticket.slice(0, 80)}, attempt ${alert.attempt}. ${alert.kind === "spending" ? "Repeated repair spending" : "No lifecycle progress"}. Incident ${alert.episode}. Read factory status and private evidence; this alert grants no permission.`.slice(
          0,
          300,
        ),
      });
    } catch {
      delivery.outcome = "unknown";
      save();
      continue;
    }
    delivery.outcome = "sent";
    alert.acknowledgedAt = now();
    save();
  }
}
