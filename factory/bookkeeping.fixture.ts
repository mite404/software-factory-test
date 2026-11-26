import type { Bookkeeping, NativeHost } from "./native";
import type { PluginTools } from "@ampcode/plugin";
import { randomUUID } from "node:crypto";

/** Inject lost delivery responses without creating threads or contacting Amp. */
export function deliveryFixture(outcome: string) {
  const messages: string[] = [];
  const delivered: string[] = [];
  const send: NativeHost["send"] = async (thread, message) => {
    if (thread === "T-owner") return;
    messages.push(message);
    if (
      outcome === "present" ||
      (messages.length === 2 && outcome !== "repeat-unknown")
    )
      delivered.push(message);
    if (messages.length === 1 || outcome.startsWith("repeat-"))
      throw new Error("lost send response");
  };
  const lookupDelivery: NonNullable<NativeHost["lookupDelivery"]> = async (
    _thread,
    message,
  ) => {
    if (outcome === "failed") throw new Error("read unavailable");
    if (outcome === "inconclusive") return "inconclusive";
    return delivered.includes(message) ? "present" : "absent";
  };
  return { messages, delivered, send, lookupDelivery };
}

function checkNotification(input: Record<string, unknown>) {
  if (
    typeof input.title !== "string" ||
    input.title.length > 100 ||
    typeof input.body !== "string" ||
    input.body.length > 300 ||
    Object.keys(input).some((key) => !["title", "body"].includes(key))
  )
    throw new Error(
      "notify_user requires title (100 chars) and body (300 chars)",
    );
}

/** Controlled connected tools; never calls the real Amp control plane. */
export function watchdogFixture(
  thread = "T-owner",
  schedules = new Map<string, Record<string, unknown>>(),
) {
  const notifications: Record<string, unknown>[] = [];
  const tools: PluginTools = {
    async call(name, input) {
      const target = typeof input.thread === "string" ? input.thread : thread;
      switch (name) {
        case "amp.get_schedule":
          return schedules.get(target) ?? null;
        case "amp.update_schedule":
          return updateFixtureSchedule(schedules, input);
        case "amp.set_schedule":
          if (schedules.has(target))
            throw new Error("Thread already has a schedule");
          schedules.set(target, {
            id: randomUUID(),
            title: input.title,
            prompt: input.prompt,
            targetThreadID: target,
            trigger: scheduleTrigger(input),
            runMode: input.run_mode,
            enabled: true,
            disabledReason: null,
            agentMode: null,
            reasoningEffort: null,
            lastRunError: null,
          });
          return schedules.get(target);
        case "amp.clear_schedule":
          schedules.delete(target);
          return { deleted: true };
        case "amp.notify_user":
          checkNotification(input);
          notifications.push(input);
          return {};
        default:
          throw new Error(`Unexpected fixture tool ${name}`);
      }
    },
  };
  return { tools, notifications, schedules };
}

function updateFixtureSchedule(
  schedules: Map<string, Record<string, unknown>>,
  input: Record<string, unknown>,
) {
  const target = [...schedules.entries()].find(
    ([, record]) => record.id === input.schedule_id,
  );
  if (!target) throw new Error("Unknown schedule_id");
  const [thread, existing] = target;
  const updated = {
    ...existing,
    title: input.title,
    prompt: input.prompt,
    trigger: scheduleTrigger(input),
    runMode: input.run_mode,
  };
  schedules.set(thread, updated);
  return updated;
}

function scheduleTrigger(input: Record<string, unknown>) {
  return {
    provider: "schedule",
    schedule: String(input.schedule).startsWith("DTSTART:")
      ? input.schedule
      : `DTSTART:19700101T000000Z\n${String(input.schedule)}`,
    scheduleLabel: input.schedule_label,
  };
}

/** Test double for external bookkeeping; factory Git and SQLite operations remain real. */
export function openStore(): Bookkeeping {
  return {
    async init() {},
    async close() {},
    ledger: { async record() {} },
  };
}
