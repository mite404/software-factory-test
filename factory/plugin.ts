import type { PluginAPI, PluginTools } from "@ampcode/plugin";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DashboardSnapshot } from "./dashboard";
import {
  configuration,
  createFactory,
  tasks,
  type Bookkeeping,
  type NativeHost,
} from "./native";

function activity(value: unknown): Awaited<ReturnType<NativeHost["state"]>> {
  switch (value) {
    case "idle":
    case "running":
    case "awaiting-approval":
    case "error":
      return value;
    default:
      return "unknown";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? { ...value } : undefined;
}

function reportedActivity(value: unknown, id: string) {
  const result = record(value);
  const metadata = record(result?.metadata);
  const agentState = record(result?.agentState);
  return metadata?.threadID === id ? activity(agentState?.state) : "unknown";
}

const runStatuses = {
  creating: "unknown",
  running: "unknown",
  blocked: "blocked",
  uncertain: "blocked",
  done: "accepted",
} satisfies Record<
  import("./persistence").Run["kind"],
  DashboardSnapshot["tasks"][number]["status"]
>;
const activityStatuses = {
  running: "working",
  idle: "idle",
  unknown: "unknown",
  "awaiting-approval": "blocked",
  error: "blocked",
} satisfies Record<
  Awaited<ReturnType<NativeHost["state"]>>,
  DashboardSnapshot["tasks"][number]["status"]
>;

/** Register the repository-local native dispatch adapter. Setup supplies the unchanged store. */
export default function registerFactory(
  amp: PluginAPI,
  root: string,
  openStore: (directory: string) => Bookkeeping,
) {
  const subscriptions: { unsubscribe(): void }[] = [];
  let stopped = false;
  let publishing = false;

  async function observe(
    id: Parameters<NativeHost["state"]>[0],
    tools?: PluginTools,
  ) {
    try {
      return activity(await amp.threads.get(id).state.get());
    } catch {
      if (!tools) return "unknown";
    }
    try {
      const result = await tools.call("amp.get_thread_status", { thread: id });
      return reportedActivity(result, id);
    } catch {
      // A failed observation is not evidence that a worker is idle or blocked.
    }
    return "unknown";
  }

  const host: NativeHost = {
    async create(parentThreadID, model, reasoningEffort) {
      const agent = amp.createAgent({
        model,
        reasoningEffort,
        instructions:
          "Implement the assigned factory ticket in its named local repository. Keep tool output concise.",
        tools: ["shell_command", "shell_command_status", "apply_patch", "Read"],
        features: [],
      });
      const thread = await agent.createThread({
        executor: "local",
        parentThreadID,
        features: [],
      });
      return thread.id;
    },
    async send(id, content) {
      await amp.threads
        .get(id)
        .appendUserMessage({ type: "user-message", content });
    },
    state: observe,
    watch(id, wake) {
      const thread = amp.threads.get(id);
      const state = thread.state.subscribe(() => {
        if (!stopped) {
          wake();
          void publish();
        }
      });
      try {
        const title = thread.title.subscribe(() => {
          if (!stopped) void publish();
        });
        subscriptions.push(state, title);
      } catch (error) {
        state.unsubscribe();
        throw error;
      }
    },
  };
  const factory = createFactory(root, host, openStore);

  async function publish(tools?: PluginTools) {
    if (stopped || publishing) return;
    publishing = true;
    try {
      const config = await configuration(root);
      const queue = tasks(JSON.parse(await readFile(config.tickets, "utf8")));
      const state = await factory.tick("status");
      const snapshot: DashboardSnapshot = {
        project: basename(root),
        enabled: state.enabled,
        observedAt: new Date().toISOString(),
        tasks: await Promise.all(
          queue.map(
            async (task): Promise<DashboardSnapshot["tasks"][number]> => {
              const run = state.runs[task.id];
              const row: DashboardSnapshot["tasks"][number] = {
                id: task.id,
                title: task.brief,
                status: "queued",
                thread: null,
                revision: null,
              };
              if (!run) return row;
              row.status = runStatuses[run.kind];
              if (run.kind === "done") row.revision = run.revision;
              if ("thread" in run && run.thread) {
                row.thread = run.thread;
                try {
                  row.title =
                    (await amp.threads.get(run.thread).title.get()) ??
                    task.brief;
                } catch {}
                if (run.kind === "running") {
                  const activity = await observe(run.thread, tools);
                  row.status = activityStatuses[activity];
                }
              }
              return row;
            },
          ),
        ),
      };
      await mkdir(factory.directory, { recursive: true });
      const path = join(factory.directory, "dashboard.json");
      await writeFile(`${path}.tmp`, JSON.stringify(snapshot));
      if (!stopped) await rename(`${path}.tmp`, path);
    } catch (error) {
      amp.logger.log("factory dashboard observation failed", String(error));
    } finally {
      publishing = false;
    }
  }

  // Native Amp events supply state changes; this model-free heartbeat detects stale observations.
  const heartbeat = setInterval(() => {
    void publish();
  }, 5000);
  void publish();
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 8);
  amp.registerTool({
    name: `factory_control_${suffix}`,
    description: `Control the factory in ${root}. status is read-only. start requires explicit user authorization and permissions.execute=true in .factory.json. pause stops dispatch. reconcile recovers persisted work without granting permissions.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "start", "pause", "reconcile"],
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const action = input.action;
      if (
        action !== "status" &&
        action !== "start" &&
        action !== "pause" &&
        action !== "reconcile"
      )
        throw new Error("Unknown action");
      const state = await factory.tick(action, ctx.thread.id, (id) =>
        observe(id, ctx.tools),
      );
      await publish(ctx.tools);
      return JSON.stringify(state);
    },
  });
  amp.onDispose(() => {
    stopped = true;
    clearInterval(heartbeat);
    for (const subscription of subscriptions) subscription.unsubscribe();
  });
  // Reload reattaches observers, but a fresh installation has no enabled state to run.
  void factory
    .tick("reconcile")
    .catch((error) => amp.logger.log("factory recovery failed", String(error)));
}
