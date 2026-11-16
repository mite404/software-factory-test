import { Database } from "bun:sqlite";
import type { AgentReasoningEffort } from "@ampcode/plugin";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validReview, type Review } from "./review";
import { validExecutor, type Executor } from "./executor";
import { validDeliveryIntent, type DeliveryIntent } from "./delivery";

const modelFamilies = new Map<string, string>([
  ["alibaba", "alibaba"],
  ["anthropic", "anthropic"],
  ["deepseek", "deepseek"],
  ["meta", "meta"],
  ["minimax", "minimax"],
  ["moonshotai", "moonshotai"],
  ["openai", "openai"],
  ["thinkingmachines", "thinkingmachines"],
  ["xai", "xai"],
  ["zhipuai", "zhipuai"],
]);
const defaultReviewerModels = new Map<string, `${string}/${string}`>([
  ["openai", "anthropic/claude-fable-5-2"],
  ["anthropic", "openai/gpt-6-astra"],
]);

export type ThreadID = `T-${string}`;
export type MergeRecord = {
  pr: number;
  commit: string;
  at: string;
};
export type WatchdogPolicy = {
  suspicionMs: number;
  spendingFirstAttempt: number;
  spendingInterval: number;
};
export type WatchdogAlert = {
  id: string;
  kind: "unresolved" | "spending" | "parked";
  episode: string;
  attempt: number;
  intendedAt: number;
  acknowledgedAt?: number;
};
export type Watchdog = {
  episode: string;
  progressAt: number;
  attempt: number;
  nudgedAt?: number;
  alerts: WatchdogAlert[];
};
/** Defaults for definitions and immutable pins authored before watchdog policy existed. */
export const defaultWatchdog: WatchdogPolicy = {
  suspicionMs: 30 * 60 * 1000,
  spendingFirstAttempt: 6,
  spendingInterval: 4,
};
/** Rejections at this attempt or later require an operator decision before owner resume. */
export const repairAttemptCap = 4;
export type Task = {
  id: string;
  brief: string;
  after: string[];
  /** Omission preserves legacy queue eligibility; only the Foreman can admit planned work. */
  intake?: "planned" | "admitted";
  /** Explicitly public text, never derived from the private brief. */
  outcome?: string;
  steps?: string[];
  size?: "small" | "medium" | "large";
  risky?: boolean;
};
type Preparation = {
  base: string;
  worktree: string;
  command: string;
  timeoutMs: number;
  log: string;
  pid?: number;
};
export type ProviderLimitPolicy =
  | { mode: "wait" }
  | {
      mode: "fallback";
      reviewerModel: `${string}/${string}`;
      workerModel?: `${string}/${string}`;
    };
export type DefinitionPin = {
  digest: string;
  scope: string[];
  verify: string;
  review: boolean;
  workerModel: `${string}/${string}`;
  workerEffort?: AgentReasoningEffort;
  workerRunner?: string;
  instructions: string;
  tickets: string;
  watchdog?: WatchdogPolicy;
  providerLimit?: ProviderLimitPolicy;
  setup?: { command: string; timeoutMs: number };
};
export type ProviderLimit = {
  message: string;
  observedAt: number;
  resetAt?: number;
};
export type StopIncident = {
  id: string;
  ticket: string;
  owner: ThreadID;
  base: string;
  attempt: number;
  reason:
    | "verification-rejected"
    | "worker-blocked"
    | "worker-error"
    | "provider-limit"
    | "approval-required"
    | "preparation-failed"
    | "preparation-interrupted"
    | "delivery-unknown"
    | "creation-unknown"
    | "target-changed"
    | "review-identity-changed";
  recovery: "resume" | "retry-setup" | "inspect" | "wait";
  providerLimit?: ProviderLimit & {
    thread: ThreadID;
    continuation?: { at: number; outcome: "sending" | "sent" | "unknown" };
  };
  delivery: "queued" | "sent";
  notifiedAt?: number;
};
export type Run = (
  | (Preparation & { kind: "preparing" })
  | (Preparation & { kind: "preparation-failed"; reason: string })
  | { kind: "creating"; base: string; worktree: string }
  | {
      kind: "running";
      base: string;
      worktree: string;
      thread: ThreadID;
      attempt: number;
      delivery: "queued" | "sending" | "sent";
      review?: Review;
      workerModel?: string;
      requirements?: string;
      feedback?: string;
      deliveryIntent?: DeliveryIntent;
    }
  | {
      kind: "blocked";
      reason: string;
      thread?: ThreadID;
      repair?: Extract<Run, { kind: "running" }>;
      checkpoint?: Extract<Run, { kind: "running" }>;
    }
  | {
      kind: "parked";
      reason: string;
      thread: ThreadID;
      repair: Extract<Run, { kind: "running" }>;
    }
  | {
      kind: "uncertain";
      reason: string;
      thread: ThreadID;
      checkpoint?: Extract<Run, { kind: "running" }>;
    }
  | {
      kind: "done";
      revision: string;
      acceptedBase?: string;
      merge?: MergeRecord;
      thread: ThreadID;
      insight: string;
      review?: Review;
      workerModel?: string;
    }
) & {
  definition?: string;
  incident?: StopIncident;
  watchdog?: Watchdog;
  executor?: Executor;
};

type RunAction =
  "retry-setup" | "retry-create" | "resume" | "record-landing" | "record-merge";
type LifecycleExit =
  { action: RunAction; when: string } | { event: string; when: string };
type LifecycleStop = {
  trigger: "stopped" | "interrupted" | "activity" | "provider";
  reasons: readonly [StopIncident["reason"], ...StopIncident["reason"][]];
  recovery: StopIncident["recovery"];
  exits: readonly LifecycleExit[];
  foremanOnly?: string;
  activity?: "error" | "awaiting-approval";
  matches?: (run: Run, reason?: StopIncident["reason"]) => boolean;
};
type LifecycleKind = {
  actions: readonly RunAction[];
  blocks: readonly ("resume" | "retry-setup" | "reconcile" | "dispatch")[];
  repairBlocks?: readonly "dispatch"[];
  exits: readonly LifecycleExit[];
  stops: Record<string, LifecycleStop>;
  reasonOverride?: boolean;
};

/** Declared lifecycle rules. Conditions describe evidence, never grant authority. */
export const runLifecycle = {
  preparing: {
    actions: ["retry-setup"],
    blocks: ["resume", "reconcile"],
    exits: [
      { event: "setup-finished", when: "the owned setup process finishes" },
    ],
    stops: {
      interrupted: {
        trigger: "interrupted",
        reasons: ["preparation-interrupted"],
        recovery: "retry-setup",
        exits: [
          {
            action: "retry-setup",
            when: "the saved setup process has stopped",
          },
        ],
      },
    },
  },
  "preparation-failed": {
    actions: ["retry-setup"],
    blocks: ["resume", "reconcile"],
    exits: [],
    stops: {
      failed: {
        trigger: "stopped",
        reasons: ["preparation-failed"],
        recovery: "retry-setup",
        exits: [
          {
            action: "retry-setup",
            when: "the saved setup process has stopped",
          },
        ],
      },
    },
  },
  creating: {
    actions: ["retry-create"],
    blocks: ["resume", "retry-setup", "reconcile"],
    exits: [
      {
        event: "created",
        when: "the original create call returns its thread identity",
      },
    ],
    stops: {
      unknown: {
        trigger: "interrupted",
        reasons: ["creation-unknown"],
        recovery: "inspect",
        exits: [
          {
            action: "retry-create",
            when: "the owner proves no thread exists and supplies the exact incident and decision",
          },
        ],
      },
    },
  },
  running: {
    actions: [],
    blocks: ["resume", "dispatch"],
    exits: [
      {
        event: "accepted",
        when: "the candidate passes its pinned gates and any required review",
      },
    ],
    stops: {
      workerDelivery: {
        trigger: "interrupted",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "running" &&
          run.delivery === "sending" &&
          !!run.deliveryIntent,
        exits: [
          {
            event: "delivery-recovered",
            when: "a complete keyed transcript lookup proves presence or permits one reserved repeat",
          },
        ],
      },
      workerDeliveryLegacy: {
        trigger: "interrupted",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "running" &&
          run.delivery === "sending" &&
          !run.deliveryIntent,
        exits: [],
        foremanOnly:
          "No saved assignment key; manual delivery inspection cannot authorize a factory retry.",
      },
      reviewerDelivery: {
        trigger: "interrupted",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "running" &&
          run.review?.delivery === "sending" &&
          !!run.review.deliveryIntent,
        exits: [
          {
            event: "delivery-recovered",
            when: "a complete keyed transcript lookup proves presence or permits one reserved repeat",
          },
        ],
      },
      reviewerDeliveryLegacy: {
        trigger: "interrupted",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "running" &&
          run.review?.delivery === "sending" &&
          !run.review.deliveryIntent,
        exits: [],
        foremanOnly: "No saved review assignment key; manual inspection only.",
      },
      reviewerCreation: {
        trigger: "interrupted",
        reasons: ["creation-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "running" && run.review?.delivery === "creating",
        exits: [],
        foremanOnly:
          "The host cannot look up an ambiguous reviewer creation; retry-create admits only worker creation.",
      },
      reviewerError: {
        trigger: "activity",
        activity: "error",
        reasons: ["worker-error"],
        recovery: "inspect",
        exits: [
          {
            event: "review-recovered",
            when: "the same reviewer is observed idle or running",
          },
        ],
      },
      reviewerApproval: {
        trigger: "activity",
        activity: "awaiting-approval",
        reasons: ["approval-required"],
        recovery: "inspect",
        exits: [
          {
            event: "review-recovered",
            when: "the same reviewer is observed idle or running",
          },
        ],
      },
      providerLimit: {
        trigger: "provider",
        reasons: ["provider-limit"],
        recovery: "wait",
        exits: [
          {
            event: "provider-continuation-sent",
            when: "connected owner reaches the saved reset or 30-minute fallback, or observes idle/running before the first continuation",
          },
          {
            event: "provider-recovered",
            when: "after any reserved continuation the same thread is observed idle or running",
          },
          {
            event: "review-fallback-creating",
            when: "a pinned valid reviewer fallback exists and has not been used; workers keep waiting",
          },
          {
            event: "blocked",
            when: "the worker reports a generic error or approval request instead of a provider limit",
          },
          {
            event: "review-stopped",
            when: "the reviewer reports a generic error or approval request instead of a provider limit",
          },
        ],
      },
    },
  },
  blocked: {
    actions: ["resume", "record-landing"],
    blocks: [],
    repairBlocks: ["dispatch"],
    exits: [],
    reasonOverride: true,
    stops: {
      repair: {
        trigger: "stopped",
        reasons: ["verification-rejected"],
        recovery: "resume",
        matches: (run) => run.kind === "blocked" && !!run.repair,
        exits: [
          {
            action: "resume",
            when: "the exact incident, owner decision and idle clean unchanged original worker checkpoint validate",
          },
          {
            action: "record-landing",
            when: "the exact incident and upstream patch and merge proofs validate",
          },
        ],
      },
      checkpoint: {
        trigger: "stopped",
        reasons: ["worker-blocked", "worker-error", "approval-required"],
        recovery: "resume",
        matches: (run) => run.kind === "blocked" && !!run.checkpoint,
        exits: [
          {
            action: "resume",
            when: "the exact incident, owner decision and idle clean unchanged original worker checkpoint validate",
          },
          {
            action: "record-landing",
            when: "the exact incident and upstream patch and merge proofs validate",
          },
          {
            event: "stop-recorded",
            when: "a connected owner observes a provider limit for a saved worker-error checkpoint and no other active work exists",
          },
        ],
      },
      targetChanged: {
        trigger: "stopped",
        reasons: ["target-changed"],
        recovery: "inspect",
        matches: (run, reason) =>
          run.kind === "blocked" && !!run.thread && reason === "target-changed",
        exits: [
          {
            action: "record-landing",
            when: "durable incident base and attempt, original thread and registered worktree prove an externally landed candidate, including multi-commit patch proof",
          },
        ],
      },
      reviewIdentityChanged: {
        trigger: "stopped",
        reasons: ["review-identity-changed"],
        recovery: "inspect",
        matches: (run, reason) =>
          run.kind === "blocked" &&
          !!run.thread &&
          reason === "review-identity-changed",
        exits: [
          {
            action: "record-landing",
            when: "durable incident base and attempt, original thread and registered worktree prove an externally landed candidate, including multi-commit patch proof",
          },
        ],
      },
      uncheckpointed: {
        trigger: "stopped",
        reasons: ["worker-blocked"],
        recovery: "inspect",
        matches: (run) => run.kind === "blocked" && !!run.thread,
        exits: [
          {
            action: "record-landing",
            when: "durable incident base and attempt, original thread and registered worktree prove an externally landed candidate, including multi-commit patch proof",
          },
          {
            event: "stop-recorded",
            when: "matching legacy report and durable events reconstruct the original checkpoint before admission",
          },
        ],
      },
      withoutWorker: {
        trigger: "stopped",
        reasons: ["worker-blocked"],
        recovery: "inspect",
        exits: [],
        foremanOnly:
          "No original worker identity or resumable checkpoint; inspection grants no execution authority.",
      },
    },
  },
  parked: {
    actions: ["resume"],
    blocks: [],
    exits: [],
    stops: {
      repair: {
        trigger: "stopped",
        reasons: ["verification-rejected"],
        recovery: "resume",
        exits: [
          {
            action: "resume",
            when: "the exact incident, operator decision and idle clean original worker validate with no other active work; the clean integration base is unchanged or a descendant, repinned on resume with rebase feedback",
          },
        ],
      },
    },
  },
  uncertain: {
    actions: [],
    blocks: ["resume", "retry-setup", "reconcile"],
    exits: [],
    stops: {
      keyed: {
        trigger: "stopped",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "uncertain" && !!run.checkpoint?.deliveryIntent,
        exits: [
          {
            event: "delivery-recovered",
            when: "a complete keyed transcript lookup proves presence or permits one reserved repeat",
          },
        ],
      },
      legacy: {
        trigger: "stopped",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        exits: [],
        foremanOnly:
          "No keyed checkpoint; no factory action can resolve the ambiguous delivery.",
      },
    },
  },
  done: { actions: ["record-merge"], blocks: [], exits: [], stops: {} },
} as const satisfies Record<Run["kind"], LifecycleKind>;

type AdmittedRun<A extends RunAction> = Extract<
  Run,
  {
    kind: {
      [
        K in keyof typeof runLifecycle
      ]: A extends (typeof runLifecycle)[K]["actions"][number] ? K : never;
    }[keyof typeof runLifecycle];
  }
>;

/** Check kind admission only; callers still validate ownership, identity and evidence. */
export function admitsRun<A extends RunAction>(
  run: Run | undefined,
  action: A,
): run is AdmittedRun<A> {
  if (!run) return false;
  const entry: LifecycleKind = runLifecycle[run.kind];
  return entry.actions.includes(action);
}

/** Whether a saved kind holds this action before its evidence-specific checks. */
export function runBlocks(
  run: Run,
  action: "resume" | "retry-setup" | "reconcile" | "dispatch",
) {
  const entry: LifecycleKind = runLifecycle[run.kind];
  return (
    entry.blocks.includes(action) ||
    (action === "dispatch" &&
      "repair" in run &&
      !!run.repair &&
      !!entry.repairBlocks?.includes(action))
  );
}

/** Resolve persisted stops and interruptions in declared precedence order. */
export function lifecycleStop(
  run: Run,
  trigger: "stopped" | "interrupted",
  reason?: StopIncident["reason"],
): [StopIncident["reason"], StopIncident["recovery"]] | undefined {
  const entry: LifecycleKind = runLifecycle[run.kind];
  const stop = Object.values(entry.stops).find(
    (stop) =>
      stop.trigger === trigger && (!stop.matches || stop.matches(run, reason)),
  );
  return (
    stop && [(entry.reasonOverride && reason) || stop.reasons[0], stop.recovery]
  );
}

/** Activity reasons are shared by worker blocking and reviewer inspection. */
export function lifecycleActivity(
  activity: "error" | "awaiting-approval",
): [StopIncident["reason"], StopIncident["recovery"]] {
  const stops: Record<string, LifecycleStop> = runLifecycle.running.stops;
  const stop = Object.values(stops).find((stop) => stop.activity === activity)!;
  return [stop.reasons[0], stop.recovery];
}

/** Compact static status reference; never includes run state or predicate source. */
export function lifecycleStatus() {
  return Object.fromEntries(
    Object.entries(runLifecycle).map(([kind, entry]) => [
      kind,
      {
        actions: entry.actions,
        blocks: entry.blocks,
        ...("repairBlocks" in entry
          ? { repairBlocks: entry.repairBlocks }
          : {}),
        exits: entry.exits,
        stops: Object.fromEntries(
          Object.entries<LifecycleStop>(entry.stops).map(
            ([name, { matches: _matches, ...stop }]) => [name, stop],
          ),
        ),
      },
    ]),
  );
}

export type State = {
  enabled: boolean;
  owner?: ThreadID;
  runs: Record<string, Run>;
  foreman?: {
    notes: { at: number; thread: ThreadID; text: string }[];
    handoffs: {
      at: number;
      from: ThreadID;
      to: ThreadID;
      decision: string;
      clear: "pending" | "cleared" | "unreachable";
      problem?: string;
    }[];
  };
  /** Last inspected registration and reserved notification effects; not a platform health guarantee. */
  monitor?: {
    fingerprint: string;
    schedule: "checking" | "installed" | "cleared" | "unknown" | "conflict";
    /** Thread to inspect before retrying an uncertain schedule effect or claiming an owner. */
    pendingThread?: ThreadID;
    /** Last confirmed reset-aligned anchor; pending effects are tracked separately. */
    wakeAt?: number;
    /** Last registration failure; owner control remains available without watchdog effects. */
    problem?: string;
    notifications: {
      id: string;
      at: number;
      outcome: "sending" | "sent" | "unknown";
    }[];
  };
};
type Event = { at: string; ticket: string; action: string; detail: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid factory record");
  return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalText(value: unknown): boolean {
  return value === undefined || text(value);
}

/** Parse public planning fields at authored and storage boundaries. @throws On invalid intake or outcome. */
export function ticketIntake(
  raw: Record<string, unknown>,
  authored = false,
): Pick<Task, "intake" | "outcome"> {
  if (
    raw.intake !== undefined &&
    raw.intake !== "planned" &&
    raw.intake !== "admitted"
  )
    throw new Error("Invalid ticket intake");
  if (authored && raw.intake === "admitted")
    throw new Error("Import cannot grant admission");
  if (
    (raw.intake !== undefined && !text(raw.outcome)) ||
    !optionalText(raw.outcome)
  )
    throw new Error("Planned tickets require an explicit public outcome");
  return {
    ...(raw.intake === undefined ? {} : { intake: raw.intake }),
    ...(raw.outcome === undefined ? {} : { outcome: raw.outcome as string }),
  };
}

/** Parse ordered authored labels; missing legacy labels become empty. @throws On malformed labels. */
export function taskSteps(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(text))
    throw new Error("Invalid ticket steps; expected nonblank string labels");
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate persisted and authored policy at the storage boundary. */
export function validWatchdogPolicy(value: unknown): value is WatchdogPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    Object.keys(policy).length === 3 &&
    ["suspicionMs", "spendingFirstAttempt", "spendingInterval"].every((key) =>
      positiveInteger(policy[key]),
    )
  );
}

function modelFamily(model: string) {
  return modelFamilies.get(model.split("/")[0]);
}

/** Resolve pstack's opposite-family adversary. @throws On unsupported worker families. */
export function reviewerModel(worker: string): `${string}/${string}` {
  const model = defaultReviewerModels.get(modelFamily(worker) ?? "");
  if (!model)
    throw new Error(
      "Review requires an OpenAI or Anthropic implementation worker",
    );
  return model;
}

/** Validate authored and pinned limit policy, preserving known opposite-family review. */
export function validProviderLimitPolicy(
  value: unknown,
  workerModel: string,
): value is ProviderLimitPolicy | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (policy.mode === "wait") return Object.keys(policy).length === 1;
  const workerFamily = modelFamily(workerModel);
  const reviewerFamily = modelFamily(String(policy.reviewerModel));
  const model = (value: unknown): value is string =>
    typeof value === "string" && /^[^\s/]+\/[^\s]+$/.test(value);
  return (
    policy.mode === "fallback" &&
    Object.keys(policy).every((key) =>
      ["mode", "reviewerModel", "workerModel"].includes(key),
    ) &&
    model(policy.reviewerModel) &&
    workerFamily !== undefined &&
    reviewerFamily !== undefined &&
    reviewerFamily !== workerFamily &&
    policy.reviewerModel !== defaultReviewerModels.get(workerFamily) &&
    (policy.workerModel === undefined || model(policy.workerModel))
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validWatchdog(value: unknown): boolean {
  const timing = record(value);
  return (
    text(timing.episode) &&
    timestamp(timing.progressAt) &&
    Number.isSafeInteger(timing.attempt) &&
    Number(timing.attempt) >= 0 &&
    (timing.nudgedAt === undefined || timestamp(timing.nudgedAt)) &&
    Array.isArray(timing.alerts) &&
    timing.alerts.every((value: unknown) => {
      const alert = record(value);
      return (
        text(alert.id) &&
        text(alert.episode) &&
        ["unresolved", "spending", "parked"].includes(String(alert.kind)) &&
        Number.isSafeInteger(alert.attempt) &&
        Number(alert.attempt) >= 0 &&
        timestamp(alert.intendedAt) &&
        (alert.acknowledgedAt === undefined || timestamp(alert.acknowledgedAt))
      );
    })
  );
}

function validateTiming(id: string, run: Record<string, unknown>) {
  if (run.watchdog !== undefined && !validWatchdog(run.watchdog))
    throw new Error(`Invalid factory watchdog ${id}`);
  const notifiedAt =
    run.incident === undefined ? undefined : record(run.incident).notifiedAt;
  if (notifiedAt !== undefined && !timestamp(notifiedAt))
    throw new Error(`Invalid factory notice time ${id}`);
}

function thread(value: unknown): value is ThreadID {
  return text(value) && value.startsWith("T-") && value.length > 2;
}

function worktreeRun(run: Record<string, unknown>): boolean {
  return text(run.base) && text(run.worktree);
}

function preparationRun(run: Record<string, unknown>): boolean {
  return (
    worktreeRun(run) &&
    ["command", "log"].every((key) => text(run[key])) &&
    positiveInteger(run.timeoutMs) &&
    run.timeoutMs <= 2_147_483_647 &&
    (run.pid === undefined || positiveInteger(run.pid)) &&
    ["thread", "attempt"].every((key) => run[key] === undefined)
  );
}

function reviewFields(run: Record<string, unknown>): boolean {
  return (
    ["workerModel", "requirements", "feedback"].every((key) =>
      optionalText(run[key]),
    ) &&
    (run.review === undefined || validReview(run.review))
  );
}

function validateMerge(id: string, run: Record<string, unknown>) {
  if (run.merge === undefined) return;
  const merge = record(run.merge);
  const valid =
    run.kind === "done" &&
    positiveInteger(merge.pr) &&
    typeof merge.commit === "string" &&
    /^[a-f0-9]{40}$/.test(merge.commit) &&
    typeof merge.at === "string" &&
    Number.isFinite(Date.parse(merge.at)) &&
    Object.keys(merge).every((key) => ["pr", "commit", "at"].includes(key));
  if (!valid) throw new Error(`Invalid factory merge ${id}`);
}

const runValidators: Record<string, (run: Record<string, unknown>) => boolean> =
  {
    preparing: preparationRun,
    "preparation-failed": (run) => preparationRun(run) && text(run.reason),
    creating: worktreeRun,
    running: (run) =>
      worktreeRun(run) &&
      thread(run.thread) &&
      positiveInteger(run.attempt) &&
      typeof run.delivery === "string" &&
      ["queued", "sending", "sent"].includes(run.delivery) &&
      validDeliveryIntent(run.deliveryIntent) &&
      reviewFields(run),
    blocked: (run) =>
      text(run.reason) &&
      (run.thread === undefined || thread(run.thread)) &&
      (run.checkpoint === undefined ||
        (run.repair === undefined &&
          validRepair(run.checkpoint, run.thread))) &&
      (run.repair === undefined ||
        (validRepair(run.repair, run.thread) && run.repair.attempt % 2 === 0)),
    parked: (run) => {
      const incident = record(run.incident);
      return (
        text(run.reason) &&
        thread(run.thread) &&
        run.checkpoint === undefined &&
        validRepair(run.repair, run.thread) &&
        run.repair.attempt >= repairAttemptCap &&
        incident.reason === "verification-rejected" &&
        incident.recovery === "resume" &&
        incident.base === run.repair.base &&
        incident.attempt === run.repair.attempt
      );
    },
    uncertain: (run) =>
      text(run.reason) &&
      thread(run.thread) &&
      (run.checkpoint === undefined ||
        validRepair(run.checkpoint, run.thread, "sending")),
    done: (run) =>
      text(run.revision) &&
      (run.acceptedBase === undefined ||
        (typeof run.acceptedBase === "string" &&
          /^[a-f0-9]{40}$/.test(run.acceptedBase))) &&
      thread(run.thread) &&
      typeof run.insight === "string" &&
      reviewFields(run),
  };

function validRepair(
  value: unknown,
  originalThread: unknown,
  delivery = "sent",
): value is Extract<Run, { kind: "running" }> {
  const run = record(value);
  return (
    run.kind === "running" &&
    runValidators.running!(run) &&
    validExecutor(run.executor) &&
    run.thread === originalThread &&
    Number.isSafeInteger(Number(run.attempt) + 1) &&
    run.delivery === delivery &&
    run.review === undefined &&
    (run.definition === undefined || validDigest(run.definition))
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function workerSettings(pin: Record<string, unknown>): boolean {
  return (
    optionalText(pin.workerRunner) &&
    validProviderLimitPolicy(pin.providerLimit, String(pin.workerModel)) &&
    new Set<unknown>([
      undefined,
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]).has(pin.workerEffort)
  );
}

function definitionFields(value: unknown) {
  const pin = record(value);
  const patterns = [
    [pin.digest, /^[a-f0-9]{64}$/],
    [pin.workerModel, /^[^/]+\/.+$/],
    [pin.verify, /\S/],
    [pin.tickets, /\S/],
  ] as const;
  return (
    patterns.every(
      ([value, pattern]) => typeof value === "string" && pattern.test(value),
    ) &&
    Array.isArray(pin.scope) &&
    pin.scope.length > 0 &&
    pin.scope.every(text) &&
    typeof pin.review === "boolean" &&
    typeof pin.instructions === "string" &&
    (pin.watchdog === undefined || validWatchdogPolicy(pin.watchdog)) &&
    workerSettings(pin)
  );
}

function validContinuation(value: unknown) {
  if (value === undefined) return true;
  const continuation = record(value);
  return (
    timestamp(continuation.at) &&
    ["sending", "sent", "unknown"].includes(String(continuation.outcome))
  );
}

function validateProviderIncident(
  id: string,
  incident: Record<string, unknown>,
) {
  if (incident.reason !== "provider-limit") return;
  const limit = record(incident.providerLimit);
  const valid =
    thread(limit.thread) &&
    text(limit.message) &&
    timestamp(limit.observedAt) &&
    (limit.resetAt === undefined || timestamp(limit.resetAt)) &&
    validContinuation(limit.continuation);
  if (incident.recovery !== "wait" || !valid)
    throw new Error(`Invalid provider limit ${id}`);
}

function validateIncident(id: string, value: unknown) {
  if (value === undefined) return;
  const incident = record(value);
  validateProviderIncident(id, incident);
  const enums = {
    delivery: ["queued", "sent"],
    recovery: ["resume", "retry-setup", "inspect", "wait"],
    reason: [
      "verification-rejected",
      "worker-blocked",
      "worker-error",
      "provider-limit",
      "approval-required",
      "preparation-failed",
      "preparation-interrupted",
      "delivery-unknown",
      "creation-unknown",
      "target-changed",
      "review-identity-changed",
    ],
  };
  const valid =
    [incident.id, incident.base].every(text) &&
    incident.ticket === id &&
    thread(incident.owner) &&
    Number.isSafeInteger(incident.attempt) &&
    Number(incident.attempt) >= 0 &&
    Object.entries(enums).every(([key, values]) =>
      values.includes(String(incident[key])),
    );
  if (!valid) throw new Error(`Invalid factory incident ${id}`);
}

function validateRun(id: string, value: unknown) {
  const run = record(value);
  validateMerge(id, run);
  validateIncident(id, run.incident);
  validateTiming(id, run);
  if (!validExecutor(run.executor))
    throw new Error(`Invalid factory executor ${id}`);
  if (run.definition !== undefined && !validDigest(run.definition))
    throw new Error(`Invalid definition pin ${id}`);
  const validate =
    typeof run.kind === "string" && Object.hasOwn(runValidators, run.kind)
      ? runValidators[run.kind]
      : undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !validate?.(run))
    throw new Error(`Invalid factory run ${id}`);
}

function validateMonitor(value: unknown) {
  if (value !== undefined) {
    const monitor = record(value);
    if (
      !text(monitor.fingerprint) ||
      (monitor.wakeAt !== undefined && !timestamp(monitor.wakeAt)) ||
      !["pendingThread", "problem"].every(
        (key) => monitor[key] === undefined || text(monitor[key]),
      ) ||
      !["checking", "installed", "cleared", "unknown", "conflict"].includes(
        String(monitor.schedule),
      ) ||
      !Array.isArray(monitor.notifications) ||
      !monitor.notifications.every((value: unknown) => {
        const notification = record(value);
        return (
          text(notification.id) &&
          timestamp(notification.at) &&
          ["sending", "sent", "unknown"].includes(String(notification.outcome))
        );
      })
    )
      throw new Error("Invalid factory monitor");
  }
}

function validateForeman(value: unknown) {
  if (value !== undefined) {
    const foreman = record(value);
    if (
      !Array.isArray(foreman.notes) ||
      !foreman.notes.every((value: unknown) => {
        const note = record(value);
        return timestamp(note.at) && thread(note.thread) && text(note.text);
      }) ||
      !Array.isArray(foreman.handoffs) ||
      !foreman.handoffs.every((value: unknown) => {
        const handoff = record(value);
        return (
          timestamp(handoff.at) &&
          thread(handoff.from) &&
          thread(handoff.to) &&
          text(handoff.decision) &&
          optionalText(handoff.problem) &&
          ["pending", "cleared", "unreachable"].includes(String(handoff.clear))
        );
      })
    )
      throw new Error("Invalid Foreman records");
  }
}

function stateRecord(value: unknown): State {
  const state = record(value);
  if (
    typeof state.enabled !== "boolean" ||
    (state.owner !== undefined && !thread(state.owner))
  )
    throw new Error("Invalid factory state");
  validateForeman(state.foreman);
  validateMonitor(state.monitor);
  for (const [id, value] of Object.entries(record(state.runs)))
    validateRun(id, value);
  return value as State;
}

function legacy(directory: string) {
  const statePath = join(directory, "state.json");
  const eventsPath = join(directory, "events.jsonl");
  const state = stateRecord(
    existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { enabled: false, runs: {} },
  );
  const lines = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split("\n")
    : [];
  if (lines.at(-1) === "") lines.pop();
  const events = lines.map((line) => {
    const event = record(JSON.parse(line));
    if (
      !text(event.at) ||
      !Number.isFinite(Date.parse(event.at)) ||
      !text(event.ticket) ||
      !text(event.action) ||
      typeof event.detail !== "string"
    )
      throw new Error("Invalid factory event");
    return event as Event;
  });
  return { state, events };
}

function database(directory: string, readonly: boolean) {
  const db = new Database(join(directory, "state.sqlite"), {
    readonly,
    strict: true,
  });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version !== 1 && version !== 2)
      throw new Error(`Unsupported factory schema version ${version}`);
    const integrity = db
      .query<{ quick_check: string }, []>("PRAGMA quick_check")
      .all();
    if (integrity.length !== 1 || integrity[0]!.quick_check !== "ok")
      throw new Error("Corrupt factory database");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readState(db: Database): State {
  const coordinator = db
    .query<{ enabled: number; owner: ThreadID | null }, []>(
      "SELECT enabled, owner FROM coordinator WHERE id = 1",
    )
    .get();
  if (!coordinator || ![0, 1].includes(coordinator.enabled))
    throw new Error("Invalid factory coordinator");
  const runs = Object.fromEntries(
    db
      .query<{ ticket: string; data: string }, []>(
        "SELECT ticket, data FROM runs",
      )
      .all()
      .map((row) => [row.ticket, JSON.parse(row.data)]),
  );
  const hasMonitor = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monitor'",
    )
    .get();
  const monitor = hasMonitor
    ? db
        .query<{ data: string }, []>("SELECT data FROM monitor WHERE id = 1")
        .get()
    : null;
  const foreman = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'foreman'",
    )
    .get()
    ? db
        .query<{ data: string }, []>("SELECT data FROM foreman WHERE id = 1")
        .get()
    : null;
  return stateRecord({
    enabled: coordinator.enabled === 1,
    ...(coordinator.owner === null ? {} : { owner: coordinator.owner }),
    runs,
    ...(monitor ? { monitor: JSON.parse(monitor.data) } : {}),
    ...(foreman ? { foreman: JSON.parse(foreman.data) } : {}),
  });
}

function saveState(db: Database, state: State) {
  stateRecord(state);
  db.query(
    "INSERT OR REPLACE INTO coordinator (id, enabled, owner) VALUES (1, ?, ?)",
  ).run(Number(state.enabled), state.owner ?? null);
  db.run("DELETE FROM runs");
  const insert = db.query("INSERT INTO runs (ticket, data) VALUES (?, ?)");
  for (const [id, run] of Object.entries(state.runs))
    insert.run(id, JSON.stringify(run));
  if (state.foreman) {
    db.run(
      "CREATE TABLE IF NOT EXISTS foreman (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
    );
    db.query("INSERT OR REPLACE INTO foreman (id, data) VALUES (1, ?)").run(
      JSON.stringify(state.foreman),
    );
  }
  if (state.monitor) {
    db.run(
      "CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
    );
    db.query("INSERT OR REPLACE INTO monitor (id, data) VALUES (1, ?)").run(
      JSON.stringify(state.monitor),
    );
  }
}

function saveEvent(db: Database, event: Event) {
  db.query(
    "INSERT INTO events (at, ticket, action, detail) VALUES (?, ?, ?, ?)",
  ).run(event.at, event.ticket, event.action, event.detail);
}

function definitionTables(db: Database) {
  if (
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
      .user_version === 2
  )
    return;
  db.run(`
    CREATE TABLE IF NOT EXISTS definitions (digest TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loaded_definition (id INTEGER PRIMARY KEY CHECK (id = 1), digest TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
}

/** Read an immutable pin or the accepted factory definition without writing storage. @throws On corrupt or missing referenced definitions. */
export function factoryDefinition(
  directory: string,
  digest?: string,
): DefinitionPin | undefined {
  if (!existsSync(join(directory, "state.sqlite"))) return undefined;
  const db = database(directory, true);
  try {
    if (
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
        .user_version === 1
    )
      return undefined;
    const row =
      digest === undefined
        ? db
            .query<{ data: string }, []>(
              "SELECT data FROM definitions JOIN loaded_definition USING (digest) WHERE id = 1",
            )
            .get()
        : db
            .query<{ data: string }, [string]>(
              "SELECT data FROM definitions WHERE digest = ?",
            )
            .get(digest);
    if (!row) {
      if (digest !== undefined) throw new Error("Missing pinned definition");
      return undefined;
    }
    const pin: unknown = JSON.parse(row.data);
    if (!definitionFields(pin)) throw new Error("Invalid stored definition");
    return pin as DefinitionPin;
  } finally {
    db.close();
  }
}

/** Read durable or validated legacy state without creating runtime files. @throws On invalid storage. */
export function factoryStatus(directory: string): State {
  if (!existsSync(join(directory, "state.sqlite")))
    return legacy(directory).state;
  const db = database(directory, true);
  try {
    return db.transaction(() => readState(db))();
  } finally {
    db.close();
  }
}

/** Read events in cursor order without creating, importing or migrating storage. @throws On invalid bounds or storage. */
export function factoryEvents(directory: string, after = 0, limit = 100) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw new Error("Invalid event bounds");
  if (!existsSync(join(directory, "state.sqlite"))) return null;
  const db = database(directory, true);
  try {
    return db
      .query<Event & { id: number }, [number, number]>(
        "SELECT id, at, ticket, action, detail FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
      )
      .all(after, limit);
  } finally {
    db.close();
  }
}

/** Read curated SQLite tickets and state together; never import legacy files. @throws On invalid storage. */
export function factoryRecords(directory: string) {
  if (!existsSync(join(directory, "state.sqlite"))) return null;
  const db = database(directory, true);
  try {
    return db.transaction(() => {
      const state = readState(db);
      const tickets = db
        .query<{ id: string; data: string }, []>(
          "SELECT id, data FROM tickets ORDER BY rowid",
        )
        .all()
        .map(({ id, data }) => {
          if (!/^[a-zA-Z0-9_-]+$/.test(id))
            throw new Error("Invalid factory ticket identity");
          const task = record(JSON.parse(data));
          return {
            id,
            steps: taskSteps(task.steps),
            ...ticketIntake(task),
          };
        });
      return { state, tickets };
    })();
  } finally {
    db.close();
  }
}

function refreshTickets(db: Database, queue: Task[], now: () => number) {
  const upsert = db.query(
    "INSERT OR REPLACE INTO tickets (id, data) VALUES (?, ?)",
  );
  for (const task of queue) {
    ticketIntake(record(task), true);
    const previous = db
      .query<{ data: string }, [string]>(
        "SELECT data FROM tickets WHERE id = ?",
      )
      .get(task.id);
    const saved = previous ? record(JSON.parse(previous.data)) : undefined;
    const intake = saved ? ticketIntake(saved).intake : undefined;
    if (intake === "admitted") continue;
    const data = JSON.stringify({
      ...task,
      ...(intake ? { intake, outcome: task.outcome ?? saved!.outcome } : {}),
    });
    if (previous?.data === data) continue;
    upsert.run(task.id, data);
    saveEvent(db, {
      at: new Date(now()).toISOString(),
      ticket: task.id,
      action: "configured",
      detail: data,
    });
  }
}

/** Open storage under the caller's poteto lock; migrate once. @throws On invalid storage or I/O. */
export function openPersistence(
  directory: string,
  queue: Task[],
  now: () => number = Date.now,
) {
  const imported = existsSync(join(directory, "state.sqlite"))
    ? null
    : legacy(directory);
  if (imported) mkdirSync(directory, { recursive: true });
  const db = imported
    ? new Database(join(directory, "state.sqlite"), {
        create: true,
        strict: true,
      })
    : database(directory, false);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const state = db.transaction(() => {
      if (imported) {
        db.run(`
          CREATE TABLE coordinator (id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), owner TEXT);
          CREATE TABLE tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE runs (ticket TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL,
            ticket TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
          PRAGMA user_version = 1;
        `);
        definitionTables(db);
        saveState(db, imported.state);
        for (const event of imported.events) saveEvent(db, event);
      }
      definitionTables(db);
      const state = readState(db);
      refreshTickets(db, queue, now);
      return state;
    })();
    return {
      state,
      /** Save a validated immutable definition, optionally accepting it for future dispatch. @throws On storage failure. */
      definition(pin: DefinitionPin, load = false) {
        db.transaction(() => {
          db.query(
            "INSERT OR IGNORE INTO definitions (digest, data) VALUES (?, ?)",
          ).run(pin.digest, JSON.stringify(pin));
          if (load)
            db.query(
              "INSERT OR REPLACE INTO loaded_definition (id, digest) VALUES (1, ?)",
            ).run(pin.digest);
        })();
      },
      tickets: db
        .query<{ data: string }, []>("SELECT data FROM tickets ORDER BY rowid")
        .all()
        .map((row) => {
          const task = JSON.parse(row.data) as Task;
          taskSteps(task.steps);
          ticketIntake(record(task));
          return task;
        }),
      /** Admit exactly one planned ticket after accepted prerequisites. @throws On missing work or unmet prerequisites. */
      admit(id: string) {
        db.transaction(() => {
          const row = db
            .query<{ data: string }, [string]>(
              "SELECT data FROM tickets WHERE id = ?",
            )
            .get(id);
          if (!row) throw new Error("Unknown planned ticket");
          const task = JSON.parse(row.data) as Task;
          if (!task.intake) throw new Error("Ticket is a legacy queue entry");
          if (task.intake === "admitted") return;
          const state = readState(db);
          if (
            !task.after.every(
              (dependency) => state.runs[dependency]?.kind === "done",
            )
          )
            throw new Error("Admission requires accepted prerequisites");
          task.intake = "admitted";
          db.query("UPDATE tickets SET data = ? WHERE id = ?").run(
            JSON.stringify(task),
            id,
          );
          saveEvent(db, {
            at: new Date(now()).toISOString(),
            ticket: id,
            action: "admitted",
            detail: "Foreman admission",
          });
        })();
      },
      /** Read the latest durable event for explicit pre-upgrade recovery. @throws On storage failure. */
      lastEvent(ticket: string, action: string) {
        return db
          .query<{ detail: string }, [string, string]>(
            "SELECT detail FROM events WHERE ticket = ? AND action = ? ORDER BY id DESC LIMIT 1",
          )
          .get(ticket, action)?.detail;
      },
      /** Persist state and its event together. @throws On transaction failure; both roll back. */
      commit(state: State, ticket: string, action: string, detail: string) {
        db.transaction(() => {
          saveState(db, state);
          saveEvent(db, {
            at: new Date(now()).toISOString(),
            ticket,
            action,
            detail,
          });
        })();
      },
      /** Append a diagnostic without inventing a state transition. @throws On I/O failure. */
      event(ticket: string, action: string, detail: string) {
        saveEvent(db, {
          at: new Date(now()).toISOString(),
          ticket,
          action,
          detail,
        });
      },
      /** Release the database before releasing the poteto lock. */
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
