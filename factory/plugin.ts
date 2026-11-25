import type {
  PluginAPI,
  PluginConfirmOptions,
  PluginTools,
  PluginToolContext,
  ThreadMessage,
  ThreadMessagesOptions,
} from "@ampcode/plugin";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { backup } from "./backup";
import {
  allowsRoleCall,
  controlToolName,
  restrictedForeman,
  roleTools,
} from "./capabilities";
import type { DashboardSnapshot } from "./dashboard";
import {
  factoryDefinition,
  factoryStatus,
  lifecycleStatus,
  repairAttemptCap,
  runStage,
  runCheckpoint,
  stages,
  type DefinitionPin,
  type Run,
  type State,
  type StopIncident,
} from "./persistence";
import { pipelineSteps } from "./pipeline";
import {
  assertControlCaller,
  effectiveConfiguration,
  createFactory,
  statusSummary,
  threadRole,
  tasks,
  type Bookkeeping,
  type NativeHost,
} from "./native";
import { observerInstructions } from "./watchdog";

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
  "record-insight",
] as const;

const automationActions = [
  "automations",
  "automation-enable",
  "automation-disable",
  "automation-run",
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
  assertControlCaller(saved, ctx.thread.id, action);
  if (action === "status") return undefined;
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

// The observer's reconcile replies carry only the summary, never full private state.
function controlReply(state: State, caller: string) {
  return JSON.stringify(
    state.foreman?.observer?.thread === caller
      ? statusSummary(state, Date.now())
      : state,
  );
}

async function confirmRepair(
  root: string,
  incident: StopIncident,
  ctx: PluginToolContext,
) {
  const binding = {
    owner: incident.owner,
    ticket: incident.ticket,
    incident: incident.id,
    attempt: incident.attempt,
    base: incident.base,
    integrationBase: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
  ctx.signal?.throwIfAborted();
  let userID: string | undefined;
  // Live `amp plugins show-docs` contract; the pinned declarations predate attribution.
  const options: PluginConfirmOptions & {
    onAnswered(answer: { responder: { userID: string } | undefined }): void;
  } = {
    title: `Resume capped factory ticket ${binding.ticket}?`,
    message: `Owner: ${binding.owner}\nTicket: ${binding.ticket}\nRejected attempt: ${binding.attempt}\nIncident: ${binding.incident}\nCandidate base: ${binding.base}\nIntegration base: ${binding.integrationBase}\nThis queues one more attempt in the original worker. It does not accept code or start a paused factory.`,
    requireHuman: true,
    endTurnOnDecline: true,
    onAnswered: ({ responder }) => {
      userID = responder?.userID;
    },
  };
  // No coordinator lock or pending tick is held while a person considers the dialog.
  const confirmed = await ctx.ui.confirm(options);
  ctx.signal?.throwIfAborted();
  if (confirmed !== true || !userID?.trim())
    throw new Error("Capped resume requires authenticated human confirmation");
  return { ...binding, userID };
}

function repairInput(
  input: Record<string, unknown>,
): Parameters<ReturnType<typeof createFactory>["tick"]>[3] {
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

async function repairRequest(
  input: Record<string, unknown>,
  saved: State,
  ctx: PluginToolContext,
  root: string,
) {
  const request = repairInput(input);
  if (input.action !== "resume" || !request) return request;
  request.signal = ctx.signal;
  const incident = saved.runs[request.ticket]?.incident;
  if (!incident || incident.attempt < repairAttemptCap) return request;
  if (incident.id !== request.incident || incident.owner !== ctx.thread.id)
    throw new Error("Resume requires the exact current stop incident");
  request.humanConfirmation = await confirmRepair(root, incident, ctx);
  return request;
}

function inputKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error(
      "Invalid checked thread request; only native identity and read pagination are accepted",
    );
}

function threadTarget(
  input: Record<string, unknown>,
  keys = ["action", "thread"],
) {
  inputKeys(input, keys);
  if (
    typeof input.thread !== "string" ||
    !/^T-[a-zA-Z0-9_-]+$/.test(input.thread)
  )
    throw new Error("Invalid checked thread target");
  return input.thread as PluginToolContext["thread"]["id"];
}

function pageInteger(value: unknown, minimum: number, maximum: number) {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error("Invalid transcript pagination");
  return value;
}

function transcriptRequest(input: Record<string, unknown>): {
  target: PluginToolContext["thread"]["id"];
  options: ThreadMessagesOptions;
} {
  const target = threadTarget(input, [
    "action",
    "thread",
    "full",
    "from",
    "offset",
    "limit",
  ]);
  if (
    (input.full !== undefined && typeof input.full !== "boolean") ||
    (input.from !== undefined && input.from !== "start" && input.from !== "end")
  )
    throw new Error("Invalid transcript pagination");
  return {
    target,
    options: {
      full: input.full as boolean | undefined,
      from: input.from as "start" | "end" | undefined,
      offset: pageInteger(input.offset, 0, Number.MAX_SAFE_INTEGER),
      limit: pageInteger(input.limit, 1, 20),
    },
  };
}

function creationInput(
  input: Record<string, unknown>,
): { ticket: string; role: "worker" | "reviewer" } | undefined {
  if (input.action !== "create-thread") return;
  inputKeys(input, ["action", "ticket", "role"]);
  if (
    typeof input.ticket !== "string" ||
    !input.ticket.trim() ||
    (input.role !== "worker" && input.role !== "reviewer")
  )
    throw new Error("Creation accepts native ticket and role identity only");
  return { ticket: input.ticket, role: input.role };
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

const activities = {
  running: "working",
  idle: "idle",
  unknown: null,
  "awaiting-approval": "blocked",
  error: "blocked",
} satisfies Record<
  Exclude<Awaited<ReturnType<NativeHost["state"]>>, object>,
  DashboardSnapshot["tasks"][number]["activity"]
>;

function retainedLaneDigest(run: Run) {
  const checkpoint = runCheckpoint(run)!;
  if (
    checkpoint.lane === "light" ||
    ("workerModel" in checkpoint &&
      checkpoint.workerModel &&
      checkpoint.workerModel !== "openai/gpt-6.1-sol")
  )
    throw new Error("Retained worker does not match the governed Sol lane");
  const digest = checkpoint.definition ?? run.definition;
  if ("thread" in checkpoint && checkpoint.thread && !digest)
    throw new Error("Retained lane identity is unavailable");
  return digest;
}

function requireGovernedLanes(
  directory: string,
  configNow: Awaited<ReturnType<typeof effectiveConfiguration>>,
) {
  const pins: DefinitionPin[] = [configNow];
  for (const run of Object.values(factoryStatus(directory).runs)) {
    if (run.kind === "done") continue;
    const digest = retainedLaneDigest(run);
    if (digest) {
      const pinned = factoryDefinition(directory, digest);
      if (!pinned) throw new Error("Retained lane identity is unavailable");
      pins.push(pinned);
    }
  }
  if (
    pins.some(
      (pin) =>
        pin.workerModel !== "openai/gpt-6.1-sol" ||
        pin.workerEffort !== "medium" ||
        pin.lightWorker ||
        !pin.review ||
        pin.providerLimit?.mode === "fallback",
    )
  )
    throw new Error(
      "Governed execution requires one Sol 6.1 medium lane and native review",
    );
}

/**
 * Register the repository-local native dispatch adapter. Setup supplies the unchanged store.
 * @throws On unsupported governed mode registration or invalid native storage.
 */
export default function registerFactory(
  amp: PluginAPI,
  root: string,
  openStore: (directory: string) => Bookkeeping,
  options: {
    /** Trusted maintenance seam; never accepted from control input. */
    restrictedForeman?: PluginToolContext["thread"]["id"];
    /** Generated source digest enables installed enforcement, not maintenance-owner migration. */
    policy?: string;
  } = {},
) {
  const subscriptions: { unsubscribe(): void }[] = [];
  const foreman = restrictedForeman(root, "openai/gpt-6.1-sol");
  const definition = {
    ...foreman,
    name: `factory-policy-${options.policy}`,
    instructions: `${foreman.instructions}\nGoverned root: ${root}\nLoaded policy: ${options.policy}`,
    reasoningEffort: "medium" as const,
  };
  const registeredAgent = options.policy
    ? amp.createAgent(definition).definition
    : undefined;
  if (registeredAgent)
    subscriptions.push(
      amp.registerAgentMode({
        key: "factory-foreman",
        label: "Factory Foreman",
        agent: registeredAgent,
      }),
    );
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

  async function policyIdentity(owner?: PluginToolContext["thread"]["id"]) {
    if (!options.policy)
      throw new Error("Loaded policy is legacy unrestricted; refresh required");
    if (!owner)
      throw new Error("Governed execution requires an owner identity");
    // Observed SDK contract: current agent definition, not display metadata or tool input.
    const actual = (await amp.threads.get(owner).agent()).definition;
    if (actual.kind !== "agent-definition")
      throw new Error(
        "Legacy built-in owner cannot activate governed execution",
      );
    if (!isDeepStrictEqual(actual, registeredAgent))
      throw new Error(
        "Owner agent does not match the loaded restricted policy",
      );
    const configNow = await effectiveConfiguration(root);
    requireGovernedLanes(factory.directory, configNow);
    return {
      policy: options.policy,
      root,
      owner,
      execute: configNow.execute,
      workerModel: configNow.workerModel,
      workerEffort: configNow.workerEffort,
      capacity: 1,
      review: configNow.review,
      agent: actual,
    };
  }

  const host: NativeHost = {
    requireExecution: options.policy
      ? async (owner) => {
          await policyIdentity(owner);
        }
      : undefined,
    async create(
      parentThreadID,
      model,
      reasoningEffort,
      role,
      executor = "local",
    ) {
      if (executor !== "local") await outsideToolCalls();
      if (options.policy) await policyIdentity(parentThreadID);
      const agent = amp.createAgent({
        model,
        reasoningEffort,
        instructions:
          role === "reviewer"
            ? "Independently review the named post-graft code artifact. Read only code, requirements, coordinator gate evidence, and the ce-code-review skill's SKILL.md and referenced files in the synced user skill caches. Do not implement or delegate. Write only the requested verdict report."
            : role === "observer"
              ? observerInstructions
              : "Implement the assigned factory ticket in its named local repository. Keep tool output concise.",
        tools: roleTools(root, role ?? "worker"),
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
    messages: (id, options) => amp.threads.get(id).messages(options),
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
  amp.on("tool.call", (event) => {
    const state = factoryStatus(factory.directory);
    const nativeRole = threadRole(state, event.thread.id);
    const role =
      options.policy && nativeRole === "foreman"
        ? "foreman"
        : event.thread.id === options.restrictedForeman
          ? nativeRole === "foreman"
            ? "foreman"
            : "retired"
          : nativeRole === "foreman"
            ? undefined
            : nativeRole;
    if (!role || allowsRoleCall(root, role, event)) return { action: "allow" };
    return {
      action: "reject-and-continue",
      message:
        "Factory capability refused: use the checked native factory control for this role",
    };
  });

  async function messageForeman(
    message: unknown,
    caller: Parameters<NativeHost["send"]>[0],
  ) {
    if (typeof message !== "string" || !message.trim())
      throw new Error("Message requires nonempty text");
    const state = factoryStatus(factory.directory);
    if (
      !state.owner ||
      (state.foreman?.observer?.thread !== caller &&
        !Object.values(state.runs).some(
          (run) =>
            (run.kind === "running" ||
              run.kind === "blocked" ||
              run.kind === "parked" ||
              run.kind === "uncertain") &&
            (run.thread === caller ||
              ("review" in run && run.review?.thread === caller)),
        ))
    )
      throw new Error(
        "Only a registered active worker, reviewer or observer may message its Foreman",
      );
    await host.send(state.owner, `Factory worker ${caller}: ${message}`);
    return { delivered: true, thread: state.owner };
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
    row.activity =
      review.delivery === "creating" || review.delivery === "sending"
        ? "blocked"
        : activities[typeof observed === "object" ? "error" : observed];
    return row;
  }

  async function publish(tools?: PluginTools) {
    if (stopped || publishing) return;
    publishing = true;
    try {
      const config = await effectiveConfiguration(root);
      const queue = tasks(
        JSON.parse(await readFile(config.tickets, "utf8")),
        true,
      );
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
                activity: null,
                thread: null,
                revision: null,
              };
              if (!run) return row;
              if (run.kind === "done") row.revision = run.revision;
              if ("thread" in run && run.thread) {
                row.thread = run.thread;
                if (run.kind === "running") {
                  const activity = await observe(run.thread, tools);
                  row.activity =
                    activities[
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
  const recordings = new Map<
    unknown,
    (input: Record<string, unknown>, ctx: PluginToolContext) => Promise<unknown>
  >([
    [
      "policy-status",
      async (_input, ctx) => {
        const state = factoryStatus(factory.directory);
        assertControlCaller(state, ctx.thread.id, "status");
        try {
          return {
            verified: true,
            ...(await policyIdentity(state.owner ?? ctx.thread.id)),
          };
        } catch (error) {
          return {
            verified: false,
            policy: options.policy ?? null,
            root,
            owner: state.owner ?? null,
            reason: String(error),
          };
        }
      },
    ],
    [
      "message-foreman",
      (input, ctx) => messageForeman(input.message, ctx.thread.id),
    ],
    [
      "read-thread",
      (input, ctx) => {
        const { target, options } = transcriptRequest(input);
        return factory.readThread(target, options, ctx.thread.id);
      },
    ],
    [
      "archive-thread",
      (input, ctx) =>
        factory.archiveThread(threadTarget(input), ctx.thread.id, ctx.tools),
    ],
    [
      "delete-thread",
      async () => {
        throw new Error(
          "Permanent thread deletion is unsupported; archive is not a substitute",
        );
      },
    ],
    [
      "status-summary",
      async (_input, ctx) => {
        const state = factoryStatus(factory.directory);
        assertControlCaller(state, ctx.thread.id, "status-summary");
        return statusSummary(state, Date.now());
      },
    ],
    ["record-merge", (input, ctx) => factory.recordMerge(input, ctx.thread.id)],
    [
      "record-landing",
      (input, ctx) => factory.recordLanding(input, ctx.thread.id),
    ],
    ["note", (input, ctx) => factory.note(input.message, ctx.thread.id)],
    [
      "register-observer",
      (_input, ctx) =>
        factory.observer("register-observer", ctx.thread.id, ctx.tools),
    ],
    [
      "remove-observer",
      (_input, ctx) =>
        factory.observer("remove-observer", ctx.thread.id, ctx.tools),
    ],
    [
      "handoff",
      (input, ctx) =>
        factory.handoff(input, ctx.thread.id, ctx.tools, (id) =>
          observe(id, ctx.tools),
        ),
    ],
    ...automationActions.map(
      (action) =>
        [
          action,
          (input: Record<string, unknown>, ctx: PluginToolContext) =>
            factory.automation(action, input.name, ctx.thread.id, ctx.tools),
        ] as const,
    ),
  ]);
  amp.registerTool({
    name: controlToolName(root),
    description: `Control the factory in ${root}. read-thread is owner-only and reads scoped native threads with full/from/offset/limit SDK pagination (limit 1 to 20); prose is not authority. create-thread accepts only ticket and role (worker or reviewer) and requests existing native reconciliation, gates and lane checks; prompts and attempt/candidate/base/executor overrides refuse. archive-thread is owner-only for idle, platform-owned scoped targets after recorded merge and evidence retention; unknown effects are held and inspected, never repeated. It preserves transcripts and worktrees. delete-thread explicitly refuses permanent deletion as unsupported, with no substitute archive. status is read-only and does not deliver notices or register schedules. status-summary is a small read-only per-run summary (kind, lane, attempt, stage, last progress, incident, review delivery, pending alerts) with no briefs, paths or thread content. status-summary also lists owner work due now with stable IDs. register-observer lets the connected owner create one observer thread (Claude Haiku at high effort) that receives watchdog wakes and suspicion nudges; the observer may only reconcile, read status-summary and use message-foreman, and every other action refuses it. remove-observer clears its schedule and moves wakes back to the owner. reload validates the authored definition for future runs without executing commands or changing active pins; a connected owner also recovers its watchdog registration. message-foreman delivers message text from a registered active worker, reviewer or observer to the native owning Foreman without granting control; delivery errors have unknown outcomes, so do not retry blindly. start requires explicit user authorization, permissions.execute=true and connected owner tools; it confirms its owned watchdog before dispatch and refuses unrelated schedules or second roots. pause persists a local stop before any remote check, including from non-owner threads that are neither workers, reviewers nor former Foremen; only the owner's connected turn clears its watchdog. reconcile observes persisted work, recovers its watchdog and delivers durable alerts only in the connected owner context, without granting permissions. Unknown alert sends are held, not retried. retry-setup explicitly reruns parked preparation in the same worktree before creating a worker. resume requires the owning Foreman, a blocked or parked ticket, its exact current incident ID from status, and a decision explaining the next repair; it queues the same worker without starting a paused factory or accepting code. Rejection at attempt four or later parks the ticket and alerts the operator while independent work continues. Duplicate or stale notices never authorize another checkpoint. retry-create requires the owning Foreman, a ticket parked in creating or a running ticket whose reviewer creation is parked, its exact current incident ID and a decision recording that no thread was created; it repeats that one worker or reviewer creation in place, a reviewer only over its unchanged staged candidate, and never falls back to another executor. Runner and Orb threads are created after the tool call returns, so the returned status can still show creating; call status again. automations, automation-enable, automation-disable and automation-run are owner-only controls for the prompts declared under factory/config/automations/ and loaded by reload. They share the factory's one Amp schedule, whose period shortens to the shortest enabled automation and never exceeds 30 minutes; each wake sends a due automation's prompt to the owner once, however many wakes were missed, and a send with an unknown outcome is recorded and never retried. enable and disable need connected owner tools; run sends once even when disabled. None of them admits, starts, resumes or dispatches work, and a file edit changes nothing until reload. backup publishes private SQLite state and requires explicit user authorization and permissions.backup=true.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            ...controlActions,
            ...recordings.keys(),
            "backup",
            "create-thread",
          ],
        },
        ticket: {
          type: "string",
          description:
            "Canonical ticket ID for admit, record-insight, record-merge or record-landing. Only the owning Foreman may use these actions; none starts or dispatches work.",
        },
        insight: {
          type: "string",
          minLength: 1,
          description:
            "For owner-only record-insight, verified evidence for an already done ticket whose insight is empty. Cannot replace existing nonempty evidence. Repeating the same value is a no-op. Then owner reload releases dependent brief refusals for rechecking without dispatching or starting a paused factory.",
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
        renames: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "For owner-only record-merge or record-landing, explicit old-to-new repository-relative file paths. Rewrites accepted patch headers, never content or upstream paths. Unused sources, unchanged paths, collisions or unproven content refuse without writes. Saved atomically in the recording event; repeat mappings must match, regardless of key order. Omitted or empty keeps ordinary proof.",
        },
        decision: {
          type: "string",
          description:
            "For resume, a repair diagnosis, not approval. At attempt four or later resume also requires an authenticated human response to the plugin's bound confirmation dialog. Decision text cannot authorize a capped resume.",
        },
        owner: {
          type: "string",
          pattern: "^T-[a-zA-Z0-9_-]+$",
          description:
            "For explicit same-orb handoff from the exact current owner. Requires a decision and connected tools; running or unknown owners, workers and reviewers are refused. Unconfirmed old-watchdog cleanup is recorded and retried without blocking new-owner monitoring or later guarded handoffs. Runs and execution permission do not change. The result includes durable Foreman notes.",
        },
        incident: { type: "string", minLength: 1 },
        thread: { type: "string", pattern: "^T-[a-zA-Z0-9_-]+$" },
        role: { type: "string", enum: ["worker", "reviewer"] },
        full: { type: "boolean" },
        from: { type: "string", enum: ["start", "end"] },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        name: {
          type: "string",
          minLength: 1,
          description:
            "Automation name (its directory under factory/config/automations/) for owner-only automation-enable, automation-disable or automation-run.",
        },
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
      const creation = creationInput(input);
      if (requested === "backup") {
        assertControlCaller(
          factoryStatus(factory.directory),
          ctx.thread.id,
          requested,
        );
        return JSON.stringify(await backup(root));
      }
      const record = recordings.get(requested);
      if (record) return JSON.stringify(await record(input, ctx));
      const action = creation
        ? "reconcile"
        : controlActions.find((action) => action === requested);
      if (!action) throw new Error("Unknown action");
      const saved = factoryStatus(factory.directory);
      const tools = connectedTools(action, saved, ctx);
      const request = await repairRequest(input, saved, ctx, root);
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
          (action === "admit" || action === "record-insight") &&
            typeof input.ticket === "string"
            ? input.ticket
            : undefined,
          typeof input.insight === "string" ? input.insight : undefined,
          creation,
        );
        if (
          action !== "reload" &&
          action !== "status" &&
          action !== "record-insight"
        )
          await publish(liveTools);
        if (action !== "status") return controlReply(state, ctx.thread.id);
        return JSON.stringify({
          ...state,
          lifecycle: lifecycleStatus(),
          pipelineSteps,
          stages,
          stage: Object.fromEntries(
            Object.entries(state.runs).map(([id, run]) => [id, runStage(run)]),
          ),
        });
      };
      calls++;
      try {
        const work = control();
        const result = await Promise.race([work, yieldCalls.promise]);
        if (result !== undefined) return result;
        work.catch((error) =>
          amp.logger.log("factory deferred creation failed", String(error)),
        );
        return controlReply(factoryStatus(factory.directory), ctx.thread.id);
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
