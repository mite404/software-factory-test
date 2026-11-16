import type {
  PluginAPI,
  PluginTools,
  PluginToolContext,
  ThreadMessage,
} from "@ampcode/plugin";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { backup } from "./backup";
import type { DashboardSnapshot } from "./dashboard";
import {
  factoryStatus,
  lifecycleStatus,
  type Run,
  type State,
} from "./persistence";
import {
  assertControlCaller,
  effectiveConfiguration,
  createFactory,
  tasks,
  type Bookkeeping,
  type NativeHost,
} from "./native";

const controlActions = [
  "status",
  "start",
  "pause",
  "reconcile",
  "retry-setup",
  "retry-create",
  "resume",
  "reload",
  "admit",
] as const;

function matchingDeliveries(page: ThreadMessage[], message: string) {
  const marker = message.slice(0, message.indexOf("\n"));
  let matches = 0;
  for (const row of page) {
    if (row.role !== "user") continue;
    const text = row.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    if (!text.includes(marker)) continue;
    if (text !== message) return undefined;
    matches++;
  }
  return matches;
}

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

function connectedTools(action: string, saved: State, ctx: PluginToolContext) {
  if (action === "status") return undefined;
  assertControlCaller(saved, ctx.thread.id);
  if (action === "start" && !ctx.tools)
    throw new Error(
      "Connected owner tools are required to install the watchdog",
    );
  // Native authorization checks start before any watchdog effect.
  if (action === "start") return ctx.tools;
  if (saved.owner === ctx.thread.id) return ctx.tools;
  return action === "pause" && saved.monitor?.pendingThread === ctx.thread.id
    ? ctx.tools
    : undefined;
}

function repairRequest(input: Record<string, unknown>) {
  if (input.action !== "resume" && input.action !== "retry-create")
    return undefined;
  if (
    typeof input.ticket !== "string" ||
    typeof input.decision !== "string" ||
    typeof input.incident !== "string"
  )
    throw new Error(
      "Resume and retry-create require ticket and decision with the current incident",
    );
  return {
    ticket: input.ticket,
    decision: input.decision,
    incident: input.incident,
  };
}

function resetTime(message: string, observedAt: number) {
  const match = /\bresets (\d{1,2})(?::([0-5]\d))?\s*(am|pm) \(UTC\)/i.exec(
    message,
  );
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12) return;
  const hour =
    (Number(match[1]) % 12) + (match[3]!.toLowerCase() === "pm" ? 12 : 0);
  const date = new Date(observedAt);
  date.setUTCHours(hour, Number(match[2] ?? 0), 0, 0);
  if (date.getTime() < observedAt) date.setUTCDate(date.getUTCDate() + 1);
  // A persistent error may first be read after reset, not when the five-hour limit was hit.
  if (date.getTime() - observedAt > 18_300_000)
    date.setUTCDate(date.getUTCDate() - 1);
  return date.getTime();
}

function rateLimitMessage(message: string) {
  const start = message.indexOf("{");
  if (start < 0) return;
  try {
    const payload = record(
      JSON.parse(message.slice(start, message.lastIndexOf("}") + 1)),
    );
    const error = record(payload?.error) ?? payload;
    if (error?.type !== "rate_limit_error" || typeof error.message !== "string")
      return;
    return error.message;
  } catch {
    return;
  }
}

function providerActivity(
  value: unknown,
): Awaited<ReturnType<NativeHost["state"]>> {
  const error = record(value);
  if (
    error?.code !== "MODEL_PROVIDER_ERROR" ||
    typeof error.message !== "string"
  )
    return "error";
  const message = rateLimitMessage(error.message);
  if (message === undefined) return "error";
  const observedAt = Date.now();
  return {
    kind: "provider-limit",
    limit: {
      message: error.message,
      observedAt,
      resetAt: resetTime(message, observedAt),
    },
  };
}

function reportedActivity(
  value: unknown,
  id: string,
): Awaited<ReturnType<NativeHost["state"]>> {
  const result = record(value);
  if (!result) return "unknown";
  const threadID = record(result.metadata)?.threadID;
  if (threadID !== undefined && threadID !== id) return "unknown";
  const agentState = record(result.agentState);
  const status = activity(agentState?.state);
  if (status === "error") return providerActivity(agentState?.agentError);
  return threadID === id ? status : "unknown";
}

const runStatuses = {
  preparing: "unknown",
  "preparation-failed": "blocked",
  creating: "unknown",
  running: "unknown",
  blocked: "blocked",
  parked: "blocked",
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
  Exclude<Awaited<ReturnType<NativeHost["state"]>>, object>,
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
  // Amp refuses a runner or Orb thread while a tool call of this plugin is in flight, so such a
  // creation asks every in-flight control call to return first and continues after the last one.
  // ponytail: a control call that arrives while a creation waits also returns before its own
  // tick has run; give each call its own completion signal if that window ever matters.
  let calls = 0;
  let yieldCalls = Promise.withResolvers<undefined>();
  let resumeCreation: (() => void) | undefined;
  async function outsideToolCalls() {
    if (!calls) return;
    await new Promise<void>((resume) => {
      resumeCreation = resume;
      yieldCalls.resolve(undefined);
    });
    yieldCalls = Promise.withResolvers<undefined>();
  }

  async function observe(
    id: Parameters<NativeHost["state"]>[0],
    tools?: PluginTools & { isConnected?(): boolean },
  ) {
    let local: Awaited<ReturnType<NativeHost["state"]>> = "unknown";
    try {
      local = activity(await amp.threads.get(id).state.get());
      if (local !== "error" || !tools) return local;
    } catch {
      if (!tools) return "unknown";
    }
    if (tools.isConnected?.() === false) return local;
    try {
      const result = await tools.call("amp.get_thread_status", { thread: id });
      return reportedActivity(result, id);
    } catch {
      // A failed observation is not evidence that a worker is idle or blocked.
    }
    return "unknown";
  }

  const host: NativeHost = {
    async create(
      parentThreadID,
      model,
      reasoningEffort,
      role,
      executor = "local",
    ) {
      if (executor !== "local") await outsideToolCalls();
      const agent = amp.createAgent({
        model,
        reasoningEffort,
        instructions:
          role === "reviewer"
            ? "Independently review the named post-graft code artifact. Read only code, requirements, coordinator gate evidence, and the ce-code-review skill's SKILL.md and referenced files in the synced user skill caches. Do not implement or delegate. Write only the requested verdict report."
            : "Implement the assigned factory ticket in its named local repository. Keep tool output concise.",
        tools: [
          "shell_command",
          "shell_command_status",
          "apply_patch",
          "Read",
          "send_thread_message",
          "plugin__*",
        ],
        features: [],
      });
      const thread = await agent.createThread({
        executor,
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
    async lookupDelivery(id, message) {
      const thread = amp.threads.get(id);
      const seen = new Set<number | string>();
      let matches = 0;
      // ponytail: cap transcript reads at 2,000 messages; longer histories stay parked.
      for (let offset = 0; offset < 2000; offset += 20) {
        const page = await thread.messages({
          full: true,
          from: "start",
          offset,
          limit: 20,
        });
        const duplicate = page.some((row) => {
          if (seen.has(row.id)) return true;
          seen.add(row.id);
          return false;
        });
        if (duplicate) return "inconclusive";
        const found = matchingDeliveries(page, message);
        if (found === undefined) return "inconclusive";
        matches += found;
        if (matches > 1) return "inconclusive";
        if (page.length < 20) return matches === 1 ? "present" : "absent";
      }
      return "inconclusive";
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

  async function messageForeman(
    message: unknown,
    caller: Parameters<NativeHost["send"]>[0],
  ) {
    if (typeof message !== "string" || !message.trim())
      throw new Error("Message requires nonempty text");
    const state = factoryStatus(factory.directory);
    if (
      !state.owner ||
      !Object.values(state.runs).some(
        (run) =>
          (run.kind === "running" ||
            run.kind === "blocked" ||
            run.kind === "parked" ||
            run.kind === "uncertain") &&
          (run.thread === caller ||
            ("review" in run && run.review?.thread === caller)),
      )
    )
      throw new Error(
        "Only a registered active worker or reviewer may message its Foreman",
      );
    await host.send(state.owner, `Factory worker ${caller}: ${message}`);
    return JSON.stringify({ delivered: true, thread: state.owner });
  }

  async function reviewProjection(
    run: Run,
    row: DashboardSnapshot["tasks"][number],
    tools?: PluginTools,
  ) {
    if (!("review" in run) || !run.review) return row;
    const review = run.review;
    row.title = `${row.id} - post-graft review (${review.delivery})`;
    row.thread = review.thread ?? null;
    row.revision = review.revision;
    if (run.kind === "done") return row;
    const observed = review.thread
      ? await observe(review.thread, tools)
      : "unknown";
    row.status =
      review.delivery === "creating" || review.delivery === "sending"
        ? "blocked"
        : activityStatuses[typeof observed === "object" ? "error" : observed];
    return row;
  }

  async function publish(tools?: PluginTools) {
    if (stopped || publishing) return;
    publishing = true;
    try {
      const config = await effectiveConfiguration(root);
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
                title: task.id,
                steps: task.steps ?? [],
                status: "queued",
                thread: null,
                revision: null,
              };
              if (!run) return row;
              row.status = runStatuses[run.kind];
              if (run.kind === "done") row.revision = run.revision;
              if ("thread" in run && run.thread) {
                row.thread = run.thread;
                if (run.kind === "running") {
                  const activity = await observe(run.thread, tools);
                  row.status =
                    activityStatuses[
                      typeof activity === "object" ? "error" : activity
                    ];
                }
              }
              return reviewProjection(run, row, tools);
            },
          ),
        ),
      };
      await mkdir(factory.directory, { recursive: true });
      const path = join(factory.directory, "dashboard.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(snapshot));
        if (!stopped) await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
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
  const recordings = new Map<
    unknown,
    (input: Record<string, unknown>, ctx: PluginToolContext) => Promise<State>
  >([
    ["record-merge", (input, ctx) => factory.recordMerge(input, ctx.thread.id)],
    [
      "record-landing",
      (input, ctx) => factory.recordLanding(input, ctx.thread.id),
    ],
    ["note", (input, ctx) => factory.note(input.message, ctx.thread.id)],
    [
      "handoff",
      (input, ctx) =>
        factory.handoff(input, ctx.thread.id, ctx.tools, (id) =>
          observe(id, ctx.tools),
        ),
    ],
  ]);
  amp.registerTool({
    name: `factory_control_${suffix}`,
    description: `Control the factory in ${root}. status is read-only and does not deliver notices or register schedules. reload validates the authored definition for future runs without executing commands or changing active pins; a connected owner also recovers its watchdog registration. message-foreman delivers message text from a registered worker or reviewer to the owning Foreman without granting control; delivery errors have unknown outcomes, so do not retry blindly. start requires explicit user authorization, permissions.execute=true and connected owner tools; it confirms its owned watchdog before dispatch and refuses unrelated schedules or second roots. pause persists a local stop before any remote check, including from non-owner threads that are neither workers, reviewers nor former Foremen; only the owner's connected turn clears its watchdog. reconcile observes persisted work, recovers its watchdog and delivers durable alerts only in the connected owner context, without granting permissions. Unknown alert sends are held, not retried. retry-setup explicitly reruns parked preparation in the same worktree before creating a worker. resume requires the owning Foreman, a blocked or parked ticket, its exact current incident ID from status, and a decision explaining the next repair; it queues the same worker without starting a paused factory or accepting code. Rejection at attempt four or later parks the ticket and alerts the operator while independent work continues. Duplicate or stale notices never authorize another checkpoint. retry-create requires the owning Foreman, a ticket parked in creating, its exact current incident ID and a decision recording that no thread was created; it repeats that one creation in place and never falls back to another executor. Runner and Orb threads are created after the tool call returns, so the returned status can still show creating; call status again. backup publishes private SQLite state and requires explicit user authorization and permissions.backup=true.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            ...controlActions,
            ...recordings.keys(),
            "message-foreman",
            "backup",
          ],
        },
        ticket: {
          type: "string",
          description:
            "Canonical ticket ID for admit, record-merge or record-landing. Only the owning Foreman may use these actions; none starts or dispatches work.",
        },
        pr: {
          type: "integer",
          minimum: 1,
          description:
            "For owner-only record-merge. Git checks the done ticket's change and commit against the fetched upstream. Recording is repeat-safe, works while paused, and has no lifecycle or schedule effects.",
        },
        commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
        revision: {
          type: "string",
          pattern: "^[a-f0-9]{40}$",
          description:
            "For owner-only record-landing, a revision descending from the saved base and reachable from the worker worktree HEAD. Requires the current incident, decision, PR and merge commit. Git must prove the exact patch upstream and the merge in both upstream and root HEAD. Later blocked reports do not disqualify earlier candidates. No dispatch or schedule effects.",
        },
        decision: { type: "string" },
        owner: {
          type: "string",
          pattern: "^T-[a-zA-Z0-9_-]+$",
          description:
            "For explicit same-orb handoff from the exact current owner. Requires a decision and connected tools; running or unknown owners, workers and reviewers are refused. Unconfirmed old-watchdog cleanup is recorded and retried without blocking new-owner monitoring or later guarded handoffs. Runs and execution permission do not change. The result includes durable Foreman notes.",
        },
        incident: { type: "string", minLength: 1 },
        message: {
          type: "string",
          minLength: 1,
          description:
            "Worker message for message-foreman, or a private dated database note for owner-only note. Notes are included in SQLite backups.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const requested = input.action;
      if (requested === "message-foreman")
        return messageForeman(input.message, ctx.thread.id);
      if (requested === "backup") {
        assertControlCaller(factoryStatus(factory.directory), ctx.thread.id);
        return JSON.stringify(await backup(root));
      }
      const record = recordings.get(requested);
      if (record) return JSON.stringify(await record(input, ctx));
      const action = controlActions.find((action) => action === requested);
      if (!action) throw new Error("Unknown action");
      const tools = connectedTools(
        action,
        factoryStatus(factory.directory),
        ctx,
      );
      const request = repairRequest(input);
      let connected = true;
      const liveTools = tools && {
        call: tools.call.bind(tools),
        isConnected: () => connected,
      };
      const control = async () => {
        const state = await factory.tick(
          action,
          ctx.thread.id,
          (id) => observe(id, liveTools),
          request,
          liveTools,
          action === "admit" && typeof input.ticket === "string"
            ? input.ticket
            : undefined,
        );
        if (action !== "reload" && action !== "status")
          await publish(liveTools);
        return JSON.stringify(
          action === "status"
            ? { ...state, lifecycle: lifecycleStatus() }
            : state,
        );
      };
      calls++;
      try {
        const work = control();
        const result = await Promise.race([work, yieldCalls.promise]);
        if (result !== undefined) return result;
        work.catch((error) =>
          amp.logger.log("factory deferred creation failed", String(error)),
        );
        return JSON.stringify(factoryStatus(factory.directory));
      } finally {
        connected = false;
        if (!--calls) {
          resumeCreation?.();
          resumeCreation = undefined;
        }
      }
    },
  });
  amp.on("agent.start", async (event, ctx) => {
    const state = factoryStatus(factory.directory);
    if (!state.owner || state.owner !== event.thread.id) return {};
    try {
      const reconciled = await factory.tick(
        "reconcile",
        event.thread.id,
        (id) => observe(id, ctx.tools),
        undefined,
        ctx.tools,
      );
      if (reconciled.monitor?.problem)
        return {
          message: {
            content: `Factory watchdog recovery failed. Monitored execution is not confirmed. Owner reconciliation continued. ${reconciled.monitor.problem}`,
            display: true,
          },
        };
      return {};
    } catch (error) {
      const confirmed =
        factoryStatus(factory.directory).monitor?.schedule === "installed";
      return {
        message: {
          content: `${confirmed ? "Factory reconciliation failed." : "Factory watchdog recovery failed. Monitored execution is not confirmed."} ${String(error)}`,
          display: true,
        },
      };
    }
  });
  amp.onDispose(() => {
    stopped = true;
    clearInterval(heartbeat);
    for (const subscription of subscriptions) subscription.unsubscribe();
  });
  // Automatic plugin-load recovery waits for confirmed monitoring; explicit reconciles still run.
  void factory
    .tick("status")
    .then((state) => {
      if (state.enabled && state.monitor?.schedule !== "installed") {
        amp.logger.log(
          "factory recovery pending connected owner watchdog inspection",
        );
        return;
      }
      return factory.tick("reconcile");
    })
    .catch((error) => amp.logger.log("factory recovery failed", String(error)));
}
