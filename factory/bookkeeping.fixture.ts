import type { Bookkeeping } from "./native";
import type { PluginTools } from "@ampcode/plugin";

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
export function watchdogFixture() {
  let schedule: Record<string, unknown> | null = null;
  const notifications: Record<string, unknown>[] = [];
  const tools: PluginTools = {
    async call(name, input) {
      switch (name) {
        case "amp.get_schedule":
          return schedule;
        case "amp.set_schedule":
          schedule = {
            id: "TEST-schedule",
            title: input.title,
            prompt: input.prompt,
            targetThreadID: "T-owner",
            trigger: {
              provider: "schedule",
              schedule: `DTSTART:20261114T143900Z\n${String(input.schedule)}`,
              scheduleLabel: input.schedule_label,
            },
            runMode: input.run_mode,
            enabled: true,
            disabledReason: null,
            agentMode: null,
            reasoningEffort: null,
            lastRunError: null,
          };
          return schedule;
        case "amp.clear_schedule":
          schedule = null;
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
  return { tools, notifications };
}

/** Test double for external bookkeeping; factory Git and SQLite operations remain real. */
export function openStore(): Bookkeeping {
  return {
    async init() {},
    async close() {},
    ledger: { async record() {} },
  };
}
