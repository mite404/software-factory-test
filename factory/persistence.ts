import { Database } from "bun:sqlite";
import type { AgentReasoningEffort } from "@ampcode/plugin";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  validNativeHooks,
  validScheduledGatePolicy,
  validVerificationCapability,
  type Automation,
  type NativeHook,
  type ScheduledGatePolicy,
} from "./config";
import { validCron } from "./cron";
import { validReview, type Review } from "./review";
import { validExecutor, type Executor } from "./executor";
import { validDeliveryIntent, type DeliveryIntent } from "./delivery";
import { greenMergeCheck, validMergeCheck } from "./github";
import type { Actor, pipelineSteps } from "./pipeline";
import type { Check } from "./config";

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
  ["openai", "openai/gpt-6.2-astra"],
  ["anthropic", "openai/gpt-6.2-astra"],
  ["moonshotai", "openai/gpt-6.2-astra"],
]);

export type ThreadID = `T-${string}`;
export type MergeRecord = {
  pr: number;
  commit: string;
  at: string;
  evidence?: {
    head: string;
    checks: Record<string, unknown>[];
    exception?: { decision: string; reason: string };
  };
};
export type WatchdogPolicy = {
  suspicionMs: number;
  disconnectMs?: number;
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
/** Default age of an unchanged tools sample before reporting a suspected stall. */
export const defaultDisconnectMs = 180_000;
/** Defaults for definitions and immutable pins authored before watchdog policy existed. */
export const defaultWatchdog: WatchdogPolicy = {
  suspicionMs: 30 * 60 * 1000,
  disconnectMs: defaultDisconnectMs,
  spendingFirstAttempt: 6,
  spendingInterval: 4,
};
/** Rejections at this attempt or later require authenticated human confirmation before owner resume. */
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
  /** Omission keeps the main lane; only a definition with lightWorker admits "light". */
  lane?: "light";
  /** Repository-relative ticket file this row synced from; authored queue entries never set it. */
  file?: string;
  /** Affected files and directories for lesson matching, not permissions. */
  lessonScope?: string[];
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
export type LightWorker = {
  model: `${string}/${string}`;
  effort: AgentReasoningEffort;
};
export type DefinitionPin = {
  digest: string;
  scope: string[];
  /** A summary of `checks` when present, else the one gate command. */
  verify: string;
  /** The gate's checks in run order, from `checks/`; absent for a flat `verify` command. */
  checks?: Check[];
  scheduledGate?: ScheduledGatePolicy;
  review: boolean;
  workerModel: `${string}/${string}`;
  workerEffort?: AgentReasoningEffort;
  workerRunner?: string;
  /** Present exactly when the authored capacity is 2; omission is today's single lane. */
  lightWorker?: LightWorker;
  /** What register-observer creates; absent in older pins, which keep the built-in observer. */
  observer?: LightWorker;
  instructions: string;
  tickets: string;
  watchdog?: WatchdogPolicy;
  providerLimit?: ProviderLimitPolicy;
  setup?: { command: string; timeoutMs: number };
  /** Accepted native hook declarations; never treated as execution permission. */
  hooks?: NativeHook[];
};
type HookOutcome =
  "refused" | "succeeded" | "failed" | "timed-out" | "uncertain";

export type ProviderLimit = {
  message: string;
  observedAt: number;
  resetAt?: number;
};
export type ThreadSample = {
  state: "running_tools" | "streaming" | "idle";
  updatedAt: number;
};
/** One check's public result: its name, whether it decides acceptance, and how it ended. */
export type CheckStatus = {
  name: string;
  required: boolean;
  status: "pass" | "fail" | "timeout";
};
/** The per-check statuses of an attempt's last gate run, recorded when that gate returns. */
export type CheckResults = { attempt: number; results: CheckStatus[] };
/** When a provider limit is treated as reset: its parsed reset, else 30 minutes after it was seen. */
export function providerResetAt(limit: ProviderLimit) {
  return limit.resetAt ?? limit.observedAt + 1_800_000;
}
type PipelineStep = (typeof pipelineSteps)[number]["id"];
/** The public reason code a first rejection by each step records; a merge rejection is a moved
 * target the candidate did not replay onto. */
export const rejectionReasons = {
  report: "report-invalid",
  gate: "gate-failed",
  review: "review-rejected",
  merge: "target-changed",
} as const satisfies Record<
  Extract<PipelineStep, "report" | "gate" | "review" | "merge">,
  StopIncident["reason"]
>;
export type StopIncident = {
  id: string;
  ticket: string;
  owner: ThreadID;
  cause?: { thread: ThreadID; role: "worker" | "reviewer" };
  base: string;
  attempt: number;
  // First-rejection reason codes belong to the `rejected` event, not a stop incident.
  reason:
    | "verification-rejected"
    | "report-invalid"
    | "gate-failed"
    | "review-rejected"
    | "worker-blocked"
    | "worker-error"
    | "disconnected"
    | "provider-limit"
    | "approval-required"
    | "preparation-failed"
    | "preparation-interrupted"
    | "delivery-unknown"
    | "creation-unknown"
    | "target-changed"
    | "review-identity-changed"
    | "evidence-missing"
    | "brief-incomplete";
  recovery: "resume" | "retry-setup" | "inspect" | "wait" | "reconnect";
  providerLimit?: ProviderLimit & {
    thread: ThreadID;
    continuation?: { at: number; outcome: "sending" | "sent" | "unknown" };
  };
  delivery: "queued" | "sent";
  notifiedAt?: number;
};
type GateProcess = {
  at: number;
  pid: number;
  start?: string;
  killed?: true;
  deadline?: number;
};

// The attempt identity survives repeat wakes and restart; each transition is also an event.
type FullGate = {
  revision: string;
  base: string;
  definition: string;
  landedAt: number;
  id: string;
} & (
  | { status: "pending" }
  | { status: "running"; process?: GateProcess }
  | { status: "interrupted" }
  | { status: "verified"; ledgerPr: number; sha256?: string }
  | { status: "passed" | "failed" | "stale"; exit: number | null }
);

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
      lessonScope?: string[];
      handoffLessons?: string[];
      feedback?: string;
      deliveryIntent?: DeliveryIntent;
      /** Last distinct connected observation for the delivered worker or reviewer. */
      stallSample?: ThreadSample & {
        thread: ThreadID;
        attempt: number;
        fingerprint?: string;
        observedAt: number;
        since: number;
      };
      /** Saved with its process group when the gate spawns and removed when it returns; a later
       * reconcile retires it once that group has stopped, and an idle report gates again.
       * `start` is the leader's boot ID and start tick, so only this gate is ever killed;
       * `killed` records that a reconcile killed it past its deadline. */
      gate?: GateProcess;
      /** The pipeline step that rejected the previous attempt. */
      rejectedBy?: keyof typeof rejectionReasons;
      /** Identity of the malformed write, so reconciling it again costs no attempt. */
      rejectedReport?: string;
      /** Absent before a gate returns; a flat `verify` gate records one required check `verify`. */
      checks?: CheckResults;
      /** The attempt a first rejection sent back to this worker, saved by that rejection. */
      rejectedAttempt?: number;
      /** The factory rebased the reported revision `from` onto `base` as `revision`, moving the
       * worker's HEAD from `source`; `at` is "verified" only once that HEAD is at `revision`. */
      rebased?: {
        from: string;
        source: string;
        revision: string;
        at: "intended" | "verified";
      };
    }
  | {
      kind: "blocked";
      reason: string;
      base?: string;
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
      acceptedAt?: number;
      /** The worker attempt that was accepted or landed; omitted by runs saved before it. */
      attempt?: number;
      /** Curated by publicSummary at acceptance; the only report text the feed may show. */
      summary?: string;
      merge?: MergeRecord;
      checks?: CheckResults;
      thread: ThreadID;
      insight: string;
      review?: Review;
      workerModel?: string;
      requirements?: string;
      landingProof?: { report: string; gate: string; review?: string };
    }
) & {
  definition?: string;
  fullGate?: FullGate;
  incident?: StopIncident;
  watchdog?: Watchdog;
  executor?: Executor;
  /** Saved at dispatch; omission is the main lane. */
  lane?: "light";
  /** When the run entered its current stage, stamped by commit; omitted in older state. */
  stageAt?: number;
};

type RunAction =
  | "retry-setup"
  | "retry-create"
  | "resume"
  | "record-landing"
  | "record-merge"
  | "record-insight"
  | "reload";

/** Read the retained worker checkpoint, or the run itself when none is retained. */
export function runCheckpoint(run: Run | undefined): Run | undefined {
  if (!run) return undefined;
  switch (run.kind) {
    case "blocked":
      return run.repair ?? run.checkpoint ?? run;
    case "parked":
      return run.repair;
    case "uncertain":
      return run.checkpoint ?? run;
    default:
      return run;
  }
}

type LifecycleExit = (
  { action: RunAction; when: string } | { event: string; when: string }
) & { actor: Actor };
type LifecycleStop = {
  actor: Actor;
  trigger: "stopped" | "interrupted" | "activity" | "provider" | "stall";
  reasons: readonly [StopIncident["reason"], ...StopIncident["reason"][]];
  recovery: StopIncident["recovery"];
  exits: readonly LifecycleExit[];
  blocks?: readonly "dispatch"[];
  /** Omission holds only the run's own lane; "factory" holds every lane. */
  holds?: "factory";
  foremanOnly?: string;
  activity?: "error" | "awaiting-approval";
  matches?: (run: Run, reason?: StopIncident["reason"]) => boolean;
};
type LifecycleKind = {
  actor: Actor;
  actions: readonly RunAction[];
  blocks: readonly ("resume" | "retry-setup" | "reconcile" | "dispatch")[];
  repairBlocks?: readonly "dispatch"[];
  exits: readonly LifecycleExit[];
  stops: Record<string, LifecycleStop>;
  reasonOverride?: boolean;
  /** Actions are admitted only while the stop holding the run's incident declares them. */
  heldActions?: true;
};

/** Declared lifecycle rules. Conditions describe evidence, never grant authority. */
export const runLifecycle = {
  preparing: {
    actor: "computer",
    actions: ["retry-setup"],
    blocks: ["resume", "reconcile"],
    exits: [
      {
        event: "setup-finished",
        when: "the owned setup process finishes",
        actor: "computer",
      },
    ],
    stops: {
      interrupted: {
        actor: "foreman",
        trigger: "interrupted",
        reasons: ["preparation-interrupted"],
        recovery: "retry-setup",
        exits: [
          {
            action: "retry-setup",
            when: "the saved setup process has stopped",
            actor: "foreman",
          },
        ],
      },
    },
  },
  "preparation-failed": {
    actor: "computer",
    actions: ["retry-setup"],
    blocks: ["resume", "reconcile"],
    exits: [],
    stops: {
      failed: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["preparation-failed"],
        recovery: "retry-setup",
        exits: [
          {
            action: "retry-setup",
            when: "the saved setup process has stopped",
            actor: "foreman",
          },
        ],
      },
    },
  },
  creating: {
    actor: "computer",
    actions: ["retry-create"],
    blocks: ["resume", "retry-setup", "reconcile"],
    exits: [
      {
        event: "created",
        when: "the original create call returns its thread identity",
        actor: "computer",
      },
    ],
    stops: {
      unknown: {
        actor: "foreman",
        trigger: "interrupted",
        reasons: ["creation-unknown"],
        recovery: "inspect",
        exits: [
          {
            action: "retry-create",
            when: "the owner proves no thread exists and supplies the exact incident and decision",
            actor: "foreman",
          },
        ],
      },
    },
  },
  running: {
    actor: "model",
    actions: ["retry-create"],
    blocks: ["resume", "dispatch"],
    heldActions: true,
    exits: [
      {
        event: "accepted",
        when: "the candidate passes its pinned gates and any required review",
        actor: "computer",
      },
    ],
    stops: {
      workerDelivery: {
        actor: "computer",
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
            actor: "computer",
          },
        ],
      },
      workerDeliveryLegacy: {
        actor: "foreman",
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
        actor: "computer",
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
            actor: "computer",
          },
        ],
      },
      reviewerDeliveryLegacy: {
        actor: "foreman",
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
        actor: "foreman",
        trigger: "interrupted",
        reasons: ["creation-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "running" && run.review?.delivery === "creating",
        exits: [
          {
            action: "retry-create",
            when: "the owner proves no reviewer exists and supplies the exact incident and decision; the staged worktree is unchanged",
            actor: "foreman",
          },
        ],
      },
      reviewerError: {
        actor: "foreman",
        trigger: "activity",
        activity: "error",
        reasons: ["worker-error"],
        recovery: "inspect",
        exits: [
          {
            event: "review-recovered",
            when: "the same reviewer is observed idle or running",
            actor: "computer",
          },
        ],
      },
      reviewerApproval: {
        actor: "operator",
        trigger: "activity",
        activity: "awaiting-approval",
        reasons: ["approval-required"],
        recovery: "inspect",
        exits: [
          {
            event: "review-recovered",
            when: "the same reviewer is observed idle or running",
            actor: "computer",
          },
        ],
      },
      disconnected: {
        actor: "operator",
        trigger: "stall",
        reasons: ["disconnected"],
        recovery: "reconnect",
        exits: [
          {
            event: "stall-cleared",
            when: "connected status or the assignment worktree shows progress",
            actor: "computer",
          },
        ],
      },
      providerLimit: {
        actor: "computer",
        trigger: "provider",
        reasons: ["provider-limit"],
        recovery: "wait",
        exits: [
          {
            event: "provider-continuation-sent",
            when: "connected owner reaches the saved reset or 30-minute fallback, or observes idle/running before the first continuation",
            actor: "computer",
          },
          {
            event: "provider-recovered",
            when: "after any reserved continuation the same thread is observed idle or running",
            actor: "computer",
          },
          {
            event: "review-fallback-creating",
            when: "a pinned valid reviewer fallback exists and has not been used; workers keep waiting",
            actor: "computer",
          },
          {
            event: "blocked",
            when: "the worker reports a generic error or approval request instead of a provider limit",
            actor: "computer",
          },
          {
            event: "review-stopped",
            when: "the reviewer reports a generic error or approval request instead of a provider limit",
            actor: "computer",
          },
        ],
      },
    },
  },
  blocked: {
    actor: "foreman",
    actions: ["resume", "record-landing", "reload"],
    blocks: [],
    repairBlocks: ["dispatch"],
    exits: [],
    reasonOverride: true,
    stops: {
      briefIncomplete: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["brief-incomplete"],
        recovery: "inspect",
        matches: (run, reason) =>
          run.kind === "blocked" &&
          (reason ?? run.incident?.reason) === "brief-incomplete",
        blocks: ["dispatch"],
        holds: "factory",
        exits: [
          {
            action: "reload",
            when: "the owner fixes the queue or definition, or records a done dependency's missing evidence with record-insight, then reloads; the ticket must remain in the queue and dispatch rechecks the current base",
            actor: "foreman",
          },
        ],
      },
      repair: {
        trigger: "stopped",
        reasons: ["verification-rejected"],
        actor: "foreman",
        recovery: "resume",
        matches: (run) => run.kind === "blocked" && !!run.repair,
        exits: [
          {
            action: "resume",
            when: "the exact incident, owner decision and idle clean unchanged original worker checkpoint validate",
            actor: "foreman",
          },
          {
            action: "record-landing",
            when: "the exact incident and upstream patch and merge proofs validate",
            actor: "foreman",
          },
        ],
      },
      checkpoint: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["worker-blocked", "worker-error", "approval-required"],
        recovery: "resume",
        matches: (run) => run.kind === "blocked" && !!run.checkpoint,
        exits: [
          {
            action: "resume",
            when: "the exact incident, owner decision and idle clean unchanged original worker checkpoint validate",
            actor: "foreman",
          },
          {
            action: "record-landing",
            when: "the exact incident and upstream patch and merge proofs validate",
            actor: "foreman",
          },
          {
            event: "stop-recorded",
            when: "a connected owner observes a provider limit for a saved worker-error checkpoint and no other active work exists",
            actor: "computer",
          },
        ],
      },
      targetChanged: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["target-changed"],
        recovery: "inspect",
        // A clean target that descends from the candidate's base is rebased, never stopped.
        matches: (run, reason) =>
          run.kind === "blocked" && !!run.thread && reason === "target-changed",
        exits: [
          {
            action: "record-landing",
            when: "durable incident base and attempt, original thread and registered worktree prove an externally landed candidate, including multi-commit patch proof",
            actor: "foreman",
          },
        ],
      },
      reviewIdentityChanged: {
        actor: "foreman",
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
            actor: "foreman",
          },
        ],
      },
      // Acceptance found no intact gate or review record bound to the exact attempt and revision.
      evidenceMissing: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["evidence-missing"],
        recovery: "inspect",
        matches: (run, reason) =>
          run.kind === "blocked" &&
          !!run.thread &&
          reason === "evidence-missing",
        exits: [
          {
            action: "record-landing",
            when: "durable incident base and attempt, original thread and registered worktree prove an externally landed candidate, including multi-commit patch proof",
            actor: "foreman",
          },
        ],
      },
      uncheckpointed: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["worker-blocked"],
        recovery: "inspect",
        matches: (run) => run.kind === "blocked" && !!run.thread,
        exits: [
          {
            action: "record-landing",
            when: "durable incident base and attempt, original thread and registered worktree prove an externally landed candidate, including multi-commit patch proof",
            actor: "foreman",
          },
          {
            event: "stop-recorded",
            when: "matching legacy report and durable events reconstruct the original checkpoint before admission",
            actor: "computer",
          },
        ],
      },
      withoutWorker: {
        actor: "foreman",
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
    actor: "operator",
    actions: ["resume", "record-landing"],
    blocks: [],
    exits: [],
    stops: {
      repair: {
        actor: "operator",
        trigger: "stopped",
        reasons: ["verification-rejected"],
        recovery: "resume",
        exits: [
          {
            action: "resume",
            when: "authenticated human confirmation bound to the exact owner, ticket, rejected attempt, incident and bases, plus an idle clean original worker validate with no other active work; the clean integration base is unchanged or a descendant, repinned on resume with rebase feedback",
            actor: "operator",
          },
          {
            action: "record-landing",
            when: "the operator landed the candidate outside the factory and the exact incident and upstream patch and merge proofs validate",
            actor: "foreman",
          },
        ],
      },
    },
  },
  uncertain: {
    actor: "foreman",
    actions: [],
    blocks: ["resume", "retry-setup", "reconcile"],
    exits: [],
    stops: {
      keyed: {
        actor: "computer",
        trigger: "stopped",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        matches: (run) =>
          run.kind === "uncertain" && !!run.checkpoint?.deliveryIntent,
        exits: [
          {
            event: "delivery-recovered",
            when: "a complete keyed transcript lookup proves presence or permits one reserved repeat",
            actor: "computer",
          },
        ],
      },
      legacy: {
        actor: "foreman",
        trigger: "stopped",
        reasons: ["delivery-unknown"],
        recovery: "inspect",
        exits: [],
        foremanOnly:
          "No keyed checkpoint; no factory action can resolve the ambiguous delivery.",
      },
    },
  },
  done: {
    actor: "computer",
    actions: ["record-merge", "record-insight"],
    blocks: [],
    exits: [
      {
        action: "record-merge",
        when: "the owner supplies verified upstream merge evidence",
        actor: "foreman",
      },
      {
        action: "record-insight",
        when: "the owner supplies the missing dependency evidence",
        actor: "foreman",
      },
    ],
    stops: {},
  },
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
  if (!entry.actions.includes(action)) return false;
  if (!entry.heldActions) return true;
  const stop = run.incident && heldBy(run)?.[1];
  return !!stop?.exits.some(
    (exit) => "action" in exit && exit.action === action,
  );
}

/** Whether a saved kind holds this action before its evidence-specific checks. */
export function runBlocks(
  run: Run,
  action: "resume" | "retry-setup" | "reconcile" | "dispatch",
) {
  const entry: LifecycleKind = runLifecycle[run.kind];
  return (
    entry.blocks.includes(action) ||
    Object.values(entry.stops).some(
      (stop) =>
        action === "dispatch" &&
        stop.blocks?.includes(action) &&
        (!stop.matches || stop.matches(run, run.incident?.reason)),
    ) ||
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
        actor: entry.actor,
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

const summaryLength = 120;

/**
 * Curate a worker's explicitly public one-line summary like a title: only text the worker marked
 * public, one line, cut to a fixed length, never paths, URLs or thread IDs.
 * @returns `{ summary }` when publishable, otherwise `{}` so the run omits the field.
 */
export function publicSummary(value: unknown): { summary?: string } {
  if (typeof value !== "string") return {};
  // ponytail: refuses known private shapes only; a reviewed allowlist if summaries widen.
  const line = value.replace(/\s+/g, " ").trim();
  if (!line || /[/\\]|https?:|\bT-[\w-]+|\p{Cc}/u.test(line)) return {};
  return {
    summary:
      line.length > summaryLength
        ? `${line.slice(0, summaryLength - 1)}…`
        : line,
  };
}

/** Every named stage in pipeline order, with who acts by default and the status word the page says for it. */
export const stages = [
  { id: "queued", actor: "computer", status: "queued" },
  { id: "planned", actor: "foreman", status: "planned" },
  { id: "preparing", actor: runLifecycle.preparing.actor, status: "unknown" },
  { id: "creating", actor: runLifecycle.creating.actor, status: "unknown" },
  { id: "building", actor: runLifecycle.running.actor, status: "unknown" },
  { id: "gating", actor: "computer", status: "unknown" },
  { id: "reviewing", actor: "model", status: "unknown" },
  {
    id: "escalated",
    actor: runLifecycle.blocked.stops.repair.actor,
    status: "blocked",
  },
  {
    id: "parked",
    actor: runLifecycle.parked.actor,
    status: "blocked",
  },
  {
    id: "rate-limited",
    actor: runLifecycle.running.stops.providerLimit.actor,
    status: "unknown",
  },
  {
    id: "disconnected",
    actor: runLifecycle.running.stops.disconnected.actor,
    status: "blocked",
  },
  {
    id: "blocked",
    actor: runLifecycle.blocked.actor,
    status: "blocked",
  },
  {
    id: "uncertain",
    actor: runLifecycle.uncertain.actor,
    status: "blocked",
  },
  { id: "accepted", actor: "foreman", status: "accepted" },
  { id: "merged", actor: null, status: "accepted" },
] as const satisfies readonly {
  id: string;
  actor: Actor | null;
  status: string;
}[];
export type Stage = (typeof stages)[number]["id"];

// The declared stop that holds a run, read from the transition table.
function heldBy(run: Run): [string, LifecycleStop] | undefined {
  const entry: LifecycleKind = runLifecycle[run.kind];
  const reason = run.incident?.reason;
  return Object.entries(entry.stops).find(
    ([, stop]) =>
      (!reason || stop.reasons.includes(reason)) &&
      (!stop.matches || stop.matches(run, reason)),
  );
}

type StageStep = [Stage, PipelineStep | null];

function runningStage(run: Extract<Run, { kind: "running" }>): StageStep {
  const step = run.review ? "review" : "builder";
  if (run.gate) return ["gating", "gate"];
  if (run.incident?.reason === "provider-limit") return ["rate-limited", step];
  if (run.incident?.reason === "disconnected") return ["disconnected", step];
  return [run.review ? "reviewing" : "building", step];
}

/** Whether a run can satisfy an acceptance dependency. Landing proof alone never qualifies. */
export function fullyVerified(run: Run | undefined): boolean {
  return (
    run?.kind === "done" && (!run.fullGate || run.fullGate.status === "passed")
  );
}

/** Public proof identity, without the command, log path or process information. */
export function projectFullGate(run: Run | undefined) {
  const gate = run?.fullGate;
  return (
    gate && {
      status: gate.status === "verified" ? "pending" : gate.status,
      landedRevision: gate.revision,
      verifiedRevision: gate.status === "passed" ? gate.revision : null,
    }
  );
}

// A retained repair names its original rejection step when that fact was saved.
const kindStages: {
  [K in Run["kind"]]: (run: Extract<Run, { kind: K }>) => StageStep;
} = {
  preparing: () => ["preparing", "setup"],
  "preparation-failed": () => ["blocked", "setup"],
  creating: () => ["creating", "builder"],
  running: runningStage,
  blocked: (run) =>
    run.repair
      ? ["escalated", run.repair.rejectedBy ?? null]
      : ["blocked", run.checkpoint ? "builder" : null],
  parked: (run) => ["parked", run.repair.rejectedBy ?? null],
  uncertain: () => ["uncertain", "builder"],
  done: (run) =>
    fullyVerified(run)
      ? [run.merge ? "merged" : "accepted", "merge"]
      : run.fullGate?.status === "stale" || run.fullGate?.status === "failed"
        ? ["blocked", "gate"]
        : ["gating", "gate"],
};

function stageOf(run: Run): StageStep {
  return (kindStages[run.kind] as (run: Run) => StageStep)(run);
}

/**
 * Name where a ticket is and who must act; the only stage mapping status, feed and notices use.
 * @param intake Separates planned from queued tickets that have no run yet.
 * @returns `actor` null means nobody; `since` is null for runs saved before stages were stamped.
 * `kind` is the run's saved kind and `stopName` the declared stop that holds it, both table keys.
 */
export function runStage(run: Run | undefined, intake?: Task["intake"]) {
  const [stage, step] = run
    ? stageOf(run)
    : [intake === "planned" ? ("planned" as const) : ("queued" as const), null];
  const declared = stages.find((entry) => entry.id === stage)!;
  const held = run?.incident ? heldBy(run) : undefined;
  return {
    stage,
    // A stop on any stage names its own actor from the transition table.
    actor: run?.incident
      ? (held?.[1].actor ?? runLifecycle[run.kind].actor)
      : declared.actor,
    status: declared.status,
    step,
    kind: run?.kind ?? null,
    stopName: held?.[0] ?? null,
    since: run?.stageAt ?? null,
    clearsAt:
      stage === "rate-limited"
        ? (run?.incident?.providerLimit?.resetAt ?? null)
        : null,
  };
}

/** One loaded automation: the authored schedule and prompt, the authored default and the control
 * override over it, when it was last armed, and its last send. `unknown` is written before the
 * send, so a crash or a lost reply leaves it and the clock never repeats that send. */
export type AutomationRecord = {
  schedule: string;
  prompt: string;
  authored: boolean;
  override?: boolean;
  armedAt: number;
  lastRunAt?: number;
  lastOutcome?: "sent" | "unknown";
};

/** Whether the control override, else the authored default, turns the automation on. */
export function automationEnabled(record: AutomationRecord) {
  return record.override ?? record.authored;
}

export type AutomationAction = "enable" | "disable" | "run";
export type AutomationRequest = {
  id: number;
  name: string;
  action: AutomationAction;
  at: number;
} & (
  | { status: "pending"; reason: null }
  | { status: "applied"; reason: null }
  | { status: "refused"; reason: string }
);

function automationRequestTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS automation_requests (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('enable', 'disable', 'run')),
    at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'applied', 'refused')), reason TEXT)`);
}

function readAutomationRequests(db: Database): AutomationRequest[] {
  if (
    !db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'automation_requests'")
      .get()
  )
    return [];
  return db
    .query<AutomationRequest, []>(
      "SELECT id, name, action, at, status, reason FROM automation_requests ORDER BY id",
    )
    .all();
}

/** Queue one dashboard intent without saving coordinator state or causing remote effects.
 * @throws If durable storage is absent or unavailable.
 */
export function enqueueAutomationRequest(
  directory: string,
  name: string,
  action: AutomationAction,
  at = Date.now(),
) {
  if (hasRestoreHold(directory))
    throw new Error(
      "Restored factory requires ownership reconciliation before queueing requests",
    );
  const db = database(directory, false);
  try {
    return db.transaction(() => {
      automationRequestTable(db);
      const row = db
        .query<{ id: number }, [string, string, number]>(
          "INSERT INTO automation_requests (name, action, at) VALUES (?, ?, ?) RETURNING id",
        )
        .get(name, action, at)!;
      return row.id;
    })();
  } finally {
    db.close();
  }
}

export type SkippedTicket = {
  file: string;
  reason: string;
};
export type State = {
  enabled: boolean;
  owner?: ThreadID;
  runs: Record<string, Run>;
  /** Ticket files the last sync could not read, each with a content-free reason. */
  skippedTickets?: SkippedTicket[];
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
    /** The one observer thread, recorded with the model and effort it was created with. */
    observer?: {
      thread: ThreadID;
      model: `${string}/${string}`;
      effort: AgentReasoningEffort;
      at: number;
    };
    /** Removed observer threads; they keep no control right of any kind. */
    retiredObservers?: ThreadID[];
    /** Recorded with native creation; rejected/replaced reviews retain their scope and role. */
    children?: Record<string, { ticket: string; role: "worker" | "reviewer" }>;
    /** Reserved before the remote archive; uncertain effects are inspected, never repeated. */
    archives?: Record<
      string,
      {
        at: number;
        owner: ThreadID;
        outcome: "sending" | "unknown" | "archived";
      }
    >;
  };
  /** Per-automation clock state, keyed by name; set from the loaded definition on reload. */
  automations?: Record<string, AutomationRecord>;
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

/** Closed outcomes per evidence kind; anything else is refused at write and read. */
export const evidenceOutcomes = {
  report: ["candidate", "candidate-typed"],
  gate: ["gate-passed", "gate-failed", "post-gate-changed", "gate-not-run"],
  "gate-rerun": ["gate-passed", "gate-failed", "post-gate-changed"],
  "landing-gate": ["gate-passed", "gate-failed", "post-gate-changed"],
  "landing-gate-rerun": ["gate-passed", "gate-failed", "post-gate-changed"],
  review: ["pass", "issues"],
} as const;
type EvidenceKind = keyof typeof evidenceOutcomes;
/** One artifact a decision used. Its identity is the commit's ticket with attempt, kind, revision, outcome and content digest. */
export type Evidence = {
  attempt: number;
  kind: EvidenceKind;
  revision: string;
  // The pinned definition digest; null for legacy unpinned runs.
  definition: string | null;
  // The check command, reviewer model or worker model that produced the content.
  tool: string;
  outcome: string;
  content: string;
};
type EvidenceRecord = Omit<Evidence, "content"> & {
  ticket: string;
  sha256: string;
  bytes: number;
  at: string;
};

const evidenceColumns =
  "ticket, attempt, kind, revision, definition, tool, outcome, sha256, bytes, at";

type PhaseLesson = {
  project: string;
  ticket: string;
  phase: string;
  sourceThread: ThreadID;
  revision: string;
  attempt: number;
  scope: string[];
  evidence: string[];
  findings: string[];
  failedApproaches: string[];
  questions: string[];
  supersedes?: string;
};
export type SavedLesson = PhaseLesson & { id: string };

const lessonLabel = /^[a-zA-Z0-9_-]{1,100}$/;
const unsafeLessonText =
  /\b(?:user|assistant|system|tool)\s*:|(?:api[ _-]?key|password|secret|token|credentials?|authorization)["']?\s*[:=]|\bBearer\s+\S+|\b(?:gh[pousr]_|github_pat_|sk[-_]|xox[baprs]-|AKIA)[\w-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|:\/\/[^\s/]+@|```|\[REDACTED:/i;

function lessonList(
  value: unknown,
  max: number,
  valid: (s: string) => boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string" && valid(item)) &&
    new Set(value).size === value.length
  );
}

function validLessonScope(value: unknown): value is string[] {
  return lessonList(
    value,
    12,
    (path) =>
      path.length <= 160 &&
      /^(?:[\w.-]+\/)*[\w.-]+\/?$/.test(path) &&
      !unsafeLessonText.test(path) &&
      !path
        .split("/")
        .some(
          (part) =>
            part === "." ||
            part === ".." ||
            part === ".git" ||
            part.startsWith(".env"),
        ),
  );
}

/** Parse authored lesson scope without changing the worker's allowed paths. @throws On invalid paths. */
export function taskLessonScope(value: unknown) {
  if (value === undefined) return undefined;
  if (!validLessonScope(value)) throw new Error("Invalid lesson scope");
  return value;
}

function lessonName(value: unknown) {
  if (
    typeof value !== "string" ||
    !lessonLabel.test(value) ||
    unsafeLessonText.test(value)
  )
    throw new Error("Invalid phase lesson identity");
  return value;
}

function lessonSummary(value: unknown) {
  if (
    !lessonList(
      value,
      2,
      (line) =>
        text(line) &&
        line.length <= 220 &&
        line === line.trim() &&
        !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line) &&
        !unsafeLessonText.test(line),
    )
  )
    throw new Error("Invalid phase lesson summary");
  return value;
}

function lessonReferences(scope: unknown, evidence: unknown) {
  if (
    !validLessonScope(scope) ||
    !scope.length ||
    !lessonList(evidence, 4, validDigest) ||
    !evidence.length
  )
    throw new Error("Invalid phase lesson scope or evidence");
  return { scope: scope.toSorted(), evidence: evidence.toSorted() };
}

function lessonSource(value: unknown): value is ThreadID {
  return thread(value) && !unsafeLessonText.test(value.slice(2));
}

function parseLesson(value: unknown): PhaseLesson {
  const row = record(value);
  const {
    project,
    ticket,
    phase,
    sourceThread,
    revision,
    attempt,
    scope,
    evidence,
    supersedes,
  } = row;
  if (
    !exactKeys(
      row,
      [
        "project",
        "ticket",
        "phase",
        "sourceThread",
        "revision",
        "attempt",
        "scope",
        "evidence",
        "findings",
        "failedApproaches",
        "questions",
      ],
      ["supersedes"],
    )
  )
    throw new Error("Invalid phase lesson");
  if (
    !lessonSource(sourceThread) ||
    !gitRevision(revision) ||
    !positiveInteger(attempt)
  )
    throw new Error("Invalid phase lesson source");
  if (supersedes !== undefined && !validDigest(supersedes))
    throw new Error("Invalid lesson supersession ID");
  const findings = lessonSummary(row.findings);
  const failedApproaches = lessonSummary(row.failedApproaches);
  const questions = lessonSummary(row.questions);
  if (findings.length + failedApproaches.length + questions.length === 0)
    throw new Error("Empty phase lesson");
  return {
    project: lessonName(project),
    ticket: lessonName(ticket),
    phase: lessonName(phase),
    sourceThread,
    revision,
    attempt,
    ...lessonReferences(scope, evidence),
    findings,
    failedApproaches,
    questions,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

function gitRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function lessonIdentity({ project, ticket, phase, revision }: PhaseLesson) {
  return sha256(JSON.stringify([project, ticket, phase, revision]));
}

function lessonProof(
  db: Database,
  lesson: PhaseLesson,
  hasContent: (digest: string) => boolean,
) {
  const rows = db
    .query<
      Pick<EvidenceRecord, "sha256" | "outcome">,
      [string, number, string]
    >(
      "SELECT sha256, outcome FROM evidence WHERE ticket = ? AND attempt = ? AND revision = ?",
    )
    .all(lesson.ticket, lesson.attempt, lesson.revision);
  return (
    lesson.evidence.every(
      (digest) =>
        rows.some((row) => row.sha256 === digest) && hasContent(digest),
    ) &&
    (!lesson.findings.length ||
      rows.some(
        (row) =>
          row.outcome === "gate-passed" && lesson.evidence.includes(row.sha256),
      ))
  );
}

function lessonHistory(db: Database, project: string, ticket: string) {
  return db
    .query<{ id: string; data: string }, [string, string]>(
      "SELECT id, data FROM lessons WHERE project = ? AND ticket = ? ORDER BY rowid",
    )
    .all(project, ticket)
    .map(({ id, data }) => ({ ...parseLesson(JSON.parse(data)), id }));
}

function reserveLesson(db: Database, id: string, target: ThreadID) {
  return (
    db
      .query(
        "INSERT OR IGNORE INTO lesson_deliveries (lesson, thread) VALUES (?, ?)",
      )
      .run(id, target).changes > 0
  );
}

function overlapsLessonScope(left: string, right: string) {
  return (
    left === right ||
    (left.endsWith("/") && right.startsWith(left)) ||
    (right.endsWith("/") && left.startsWith(right))
  );
}

/** The content digest that names a preserved artifact. */
export function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

// Content is addressed by digest beside the database, so equal bytes converge on one file.
function evidencePath(directory: string, digest: string) {
  return join(directory, "evidence", digest);
}

function intact(directory: string, digest: string) {
  try {
    return sha256(readFileSync(evidencePath(directory, digest))) === digest;
  } catch {
    return false;
  }
}

function preserve(directory: string, content: string) {
  const digest = sha256(content);
  if (!intact(directory, digest)) {
    mkdirSync(join(directory, "evidence"), { recursive: true });
    const temporary = `${evidencePath(directory, digest)}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, evidencePath(directory, digest));
    if (!intact(directory, digest))
      throw new Error("Evidence preservation failed");
  }
  return { sha256: digest, bytes: Buffer.byteLength(content) };
}

// Preserve and verify every content first, so no row ever names bytes that were not written.
function preparedEvidence(
  directory: string,
  ticket: string,
  evidence: Evidence[],
  at: number,
): EvidenceRecord[] {
  if (!evidence.every(validEvidence)) throw new Error("Invalid evidence");
  return evidence.map(({ content, ...item }) => ({
    ...item,
    ticket,
    ...preserve(directory, content),
    at: new Date(at).toISOString(),
  }));
}

function validEvidence(item: Omit<Evidence, "content">) {
  return (
    positiveInteger(item.attempt) &&
    Object.hasOwn(evidenceOutcomes, item.kind) &&
    (evidenceOutcomes[item.kind] as readonly string[]).includes(item.outcome) &&
    /^[a-f0-9]{40}$/.test(item.revision) &&
    (item.definition === null || validDigest(item.definition)) &&
    text(item.tool)
  );
}

function hasTable(db: Database, name: "evidence" | "lessons") {
  return !!db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

/** Enumerate required backup identities from the frozen database, not the live directory.
 * @throws On invalid evidence or lesson references.
 */
export function backupCoverage(snapshot: string) {
  const db = new Database(snapshot, { readonly: true, strict: true });
  try {
    const evidence = hasTable(db, "evidence")
      ? db
          .query<EvidenceRecord, []>(
            `SELECT ${evidenceColumns} FROM evidence ORDER BY ticket, attempt, kind, revision, outcome, sha256`,
          )
          .all()
          .map((row) => {
            const { ticket, attempt, kind, revision, outcome, sha256, bytes } =
              row;
            if (
              !validEvidence(row) ||
              !validDigest(sha256) ||
              !Number.isSafeInteger(bytes) ||
              bytes < 0
            )
              throw new Error("Invalid evidence digest or size");
            return { ticket, attempt, kind, revision, outcome, sha256, bytes };
          })
      : [];
    const lessons = hasTable(db, "lessons")
      ? db
          .query<{ id: string; data: string }, []>(
            "SELECT id, data FROM lessons ORDER BY id",
          )
          .all()
          .map(({ id, data }) => {
            const lesson = parseLesson(JSON.parse(data));
            const { project, ticket, phase, attempt, revision } = lesson;
            if (
              id !== lessonIdentity(lesson) ||
              !lessonProof(db, lesson, () => true)
            )
              throw new Error("Invalid lesson backup coverage");
            return { id, project, ticket, phase, attempt, revision };
          })
      : [];
    return { evidence, lessons };
  } finally {
    db.close();
  }
}

function saveEvidence(db: Database, record: EvidenceRecord) {
  const saved = db
    .query<EvidenceRecord, [string, number, string, string, string, string]>(
      `SELECT ${evidenceColumns} FROM evidence WHERE ticket = ? AND attempt = ? AND kind = ? AND revision = ? AND outcome = ? AND sha256 = ?`,
    )
    .get(
      record.ticket,
      record.attempt,
      record.kind,
      record.revision,
      record.outcome,
      record.sha256,
    );
  if (!saved) {
    db.query(
      `INSERT INTO evidence (${evidenceColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.ticket,
      record.attempt,
      record.kind,
      record.revision,
      record.definition,
      record.tool,
      record.outcome,
      record.sha256,
      record.bytes,
      record.at,
    );
    return;
  }
  if (
    (["definition", "tool"] as const).some((key) => saved[key] !== record[key])
  )
    throw new Error("Conflicting provenance for recorded evidence");
}

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
    Object.keys(policy).length ===
      (Object.hasOwn(policy, "disconnectMs") ? 4 : 3) &&
    (!Object.hasOwn(policy, "disconnectMs") ||
      positiveInteger(policy.disconnectMs)) &&
    ["suspicionMs", "spendingFirstAttempt", "spendingInterval"].every((key) =>
      positiveInteger(policy[key]),
    )
  );
}

function modelFamily(model: string) {
  return modelFamilies.get(model.split("/")[0]);
}

/** Resolve the native cold reviewer. @throws On unsupported worker families. */
export function reviewerModel(worker: string): `${string}/${string}` {
  const model = defaultReviewerModels.get(modelFamily(worker) ?? "");
  if (!model)
    throw new Error(
      "Review requires an OpenAI, Anthropic, or Moonshot AI implementation worker",
    );
  return model;
}

/** Validate authored and pinned limit policy, preserving independent fallback review. */
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
  if (run.stageAt !== undefined && !timestamp(run.stageAt))
    throw new Error(`Invalid factory stage time ${id}`);
}

function thread(value: unknown): value is ThreadID {
  return text(value) && value.startsWith("T-") && value.length > 2;
}

function validStallSample(value: unknown) {
  if (value === undefined) return true;
  const sample = record(value);
  return (
    thread(sample.thread) &&
    positiveInteger(sample.attempt) &&
    ["running_tools", "streaming", "idle"].includes(String(sample.state)) &&
    optionalFingerprint(sample.fingerprint) &&
    stallTimes(sample.updatedAt, sample.since, sample.observedAt)
  );
}

function optionalFingerprint(value: unknown) {
  return value === undefined || validDigest(value);
}

function stallTimes(updatedAt: unknown, since: unknown, observedAt: unknown) {
  return (
    timestamp(updatedAt) &&
    timestamp(since) &&
    timestamp(observedAt) &&
    updatedAt <= since &&
    since <= observedAt
  );
}

function worktreeRun(run: Record<string, unknown>): boolean {
  return (
    text(run.base) &&
    text(run.worktree) &&
    (run.lessonScope === undefined || validLessonScope(run.lessonScope)) &&
    (run.handoffLessons === undefined ||
      lessonList(run.handoffLessons, 3, validDigest))
  );
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

function revision(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function validRebase(value: unknown): boolean {
  if (value === undefined) return true;
  const rebase = record(value);
  return (
    [rebase.from, rebase.source, rebase.revision].every(revision) &&
    (rebase.at === "intended" || rebase.at === "verified") &&
    Object.keys(rebase).length === 4
  );
}

// A check's saved deadline, which older markers lack.
function validDeadline(gate: Record<string, unknown>) {
  return (
    gate.deadline === undefined ||
    (timestamp(gate.deadline) && gate.deadline > Number(gate.at))
  );
}

// The leader's identity; `killed` needs the `start` that identified the group it killed.
function validGateIdentity(gate: Record<string, unknown>) {
  const start =
    gate.start === undefined ||
    (typeof gate.start === "string" && /^[0-9a-f-]+:\d+$/.test(gate.start));
  const killed =
    gate.killed === undefined ||
    (gate.killed === true && gate.start !== undefined);
  return start && killed;
}

function validGateMarker(gate: Record<string, unknown>): boolean {
  return (
    timestamp(gate.at) &&
    positiveInteger(gate.pid) &&
    validDeadline(gate) &&
    validGateIdentity(gate) &&
    Object.keys(gate).every((key) =>
      ["at", "pid", "start", "killed", "deadline"].includes(key),
    )
  );
}

// A running gate marker and the step that rejected the previous attempt.
function validStageFacts(run: Record<string, unknown>): boolean {
  return (
    (run.gate === undefined || validGateMarker(record(run.gate))) &&
    validCheckResults(run.checks) &&
    [undefined, ...Object.keys(rejectionReasons)].some(
      (step) => step === run.rejectedBy,
    ) &&
    (run.rejectedReport === undefined || validDigest(run.rejectedReport)) &&
    (run.rejectedAttempt === undefined || positiveInteger(run.rejectedAttempt))
  );
}

const checkName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function exactKeys(value: unknown, keys: string[], optional: string[] = []) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every(
      (key) => keys.includes(key) || optional.includes(key),
    ) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

// A list of uniquely named checks with at least one required; `valid` checks the rest of each.
function namedChecks(
  value: unknown,
  keys: string[],
  valid: (item: Record<string, unknown>) => boolean,
  optional: string[] = [],
) {
  if (!Array.isArray(value) || !value.length) return false;
  const items = value as Record<string, unknown>[];
  return (
    items.every(
      (item) =>
        exactKeys(item, keys, optional) &&
        typeof item.name === "string" &&
        checkName.test(item.name) &&
        typeof item.required === "boolean" &&
        valid(item),
    ) &&
    items.some((item) => item.required) &&
    new Set(items.map((item) => item.name)).size === items.length
  );
}

function validCheckResults(value: unknown) {
  if (value === undefined) return true;
  const results = value as Record<string, unknown>;
  return (
    exactKeys(value, ["attempt", "results"]) &&
    positiveInteger(results.attempt) &&
    namedChecks(results.results, ["name", "required", "status"], (item) =>
      ["pass", "fail", "timeout"].includes(String(item.status)),
    )
  );
}

function validPinnedChecks(value: unknown) {
  return (
    value === undefined ||
    namedChecks(
      value,
      ["name", "command", "required", "timeoutMs"],
      (item) =>
        text(item.command) &&
        positiveInteger(item.timeoutMs) &&
        (item.capability === undefined ||
          validVerificationCapability(item.capability)),
      ["capability"],
    )
  );
}

// The acceptance time and the curated public summary, both optional for older runs.
function validAcceptance(run: Record<string, unknown>): boolean {
  return (
    (run.acceptedAt === undefined || timestamp(run.acceptedAt)) &&
    (run.attempt === undefined || positiveInteger(run.attempt)) &&
    (run.summary === undefined ||
      publicSummary(run.summary).summary === run.summary)
  );
}

function validMergeException(value: unknown) {
  const exception = record(value);
  return (
    text(exception.decision) &&
    text(exception.reason) &&
    Object.keys(exception).length === 2
  );
}

function validMergeChecks(checks: Record<string, unknown>[]) {
  if (!checks.every(validMergeCheck)) return false;
  const ids = checks.flatMap(({ id }) => (id === undefined ? [] : [id]));
  return new Set(ids).size === ids.length;
}

function validMergeEvidence(value: unknown) {
  if (value === undefined) return true;
  const evidence = record(value);
  return (
    typeof evidence.head === "string" &&
    /^[a-f0-9]{40}$/.test(evidence.head) &&
    Array.isArray(evidence.checks) &&
    validMergeChecks(evidence.checks) &&
    Object.keys(evidence).every((key) =>
      ["head", "checks", "exception"].includes(key),
    ) &&
    (evidence.exception === undefined
      ? evidence.checks.length > 0 && evidence.checks.every(greenMergeCheck)
      : validMergeException(evidence.exception))
  );
}

function validMergeRecord(merge: Record<string, unknown>) {
  return (
    positiveInteger(merge.pr) &&
    typeof merge.commit === "string" &&
    /^[a-f0-9]{40}$/.test(merge.commit) &&
    typeof merge.at === "string" &&
    Number.isFinite(Date.parse(merge.at)) &&
    validMergeEvidence(merge.evidence) &&
    Object.keys(merge).every((key) =>
      ["pr", "commit", "at", "evidence"].includes(key),
    )
  );
}

function validateMerge(id: string, run: Record<string, unknown>) {
  if (run.merge === undefined) return;
  if (run.kind !== "done" || !validMergeRecord(record(run.merge)))
    throw new Error(`Invalid factory merge ${id}`);
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
      ["queued", "sending", "sent"].some((state) => state === run.delivery) &&
      validDeliveryIntent(run.deliveryIntent) &&
      validStallSample(run.stallSample) &&
      reviewFields(run) &&
      validRebase(run.rebased) &&
      validStageFacts(run),
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
      validAcceptance(run) &&
      validCheckResults(run.checks) &&
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

const efforts = new Set<unknown>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Validate an authored or pinned light lane: a known model family and a supported effort. */
export function validLightWorker(value: unknown): value is LightWorker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const light = value as Record<string, unknown>;
  return (
    Object.keys(light).every((key) => key === "model" || key === "effort") &&
    typeof light.model === "string" &&
    /^[^/]+\/.+$/.test(light.model) &&
    modelFamily(light.model) !== undefined &&
    efforts.has(light.effort)
  );
}

export type Lane = "main" | "light";

/** The lane a run was dispatched into; runs saved before lanes existed are main. */
export function runLane(run: Run): Lane {
  return run.lane ?? "main";
}

function factoryHold(run: Run, action: "resume" | "retry-setup" | "dispatch") {
  const entry: LifecycleKind = runLifecycle[run.kind];
  return Object.values(entry.stops).some(
    (stop) =>
      stop.holds === "factory" &&
      stop.blocks?.includes(action as "dispatch") &&
      (!stop.matches || stop.matches(run, run.incident?.reason)),
  );
}

/** The one admission check for every transition that takes a lane: dispatch, resume,
 * provider-error restoration and retry-setup. `except` names the run being restored.
 * One lane keeps the rules from before lanes. With two lanes every other unfinished run of the
 * lane holds it, parked included, and only factory-scoped stops hold the other lane.
 */
export function laneHeld(
  runs: State["runs"],
  lane: Lane,
  action: "resume" | "retry-setup" | "dispatch",
  twoLanes: boolean,
  except?: string,
) {
  return Object.entries(runs).some(
    ([id, run]) =>
      id !== except &&
      (twoLanes
        ? (runLane(run) === lane && run.kind !== "done") ||
          factoryHold(run, action)
        : runBlocks(run, action) ||
          (action === "dispatch" && runBlocks(run, "reconcile"))),
  );
}

function workerSettings(pin: Record<string, unknown>): boolean {
  return (
    optionalText(pin.workerRunner) &&
    validProviderLimitPolicy(pin.providerLimit, String(pin.workerModel)) &&
    (pin.workerEffort === undefined || efforts.has(pin.workerEffort)) &&
    (pin.lightWorker === undefined ||
      (validLightWorker(pin.lightWorker) &&
        validProviderLimitPolicy(pin.providerLimit, pin.lightWorker.model))) &&
    optionalAgent(pin.observer)
  );
}

// An agent setting that older pins lack.
function optionalAgent(value: unknown) {
  return value === undefined || validLightWorker(value);
}

function gateAndWatchdog(pin: Record<string, unknown>) {
  return (
    validPinnedChecks(pin.checks) &&
    (pin.scheduledGate === undefined ||
      validScheduledGatePolicy(pin.scheduledGate)) &&
    (pin.watchdog === undefined || validWatchdogPolicy(pin.watchdog))
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
    validNativeHooks(pin.hooks) &&
    gateAndWatchdog(pin) &&
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

function validateIncidentCause(id: string, value: unknown) {
  if (value !== undefined) {
    const cause = record(value);
    if (
      typeof cause.thread !== "string" ||
      /^T-[\w-]+$/.exec(cause.thread)?.[0] !== cause.thread ||
      !["worker", "reviewer"].includes(String(cause.role))
    )
      throw new Error(`Invalid factory incident cause ${id}`);
  }
}

function validateIncident(id: string, value: unknown) {
  if (value === undefined) return;
  const incident = record(value);
  validateIncidentCause(id, incident.cause);
  validateProviderIncident(id, incident);
  const enums = {
    delivery: ["queued", "sent"],
    recovery: ["resume", "retry-setup", "inspect", "wait", "reconnect"],
    reason: [
      "verification-rejected",
      "worker-blocked",
      "worker-error",
      "disconnected",
      "provider-limit",
      "approval-required",
      "preparation-failed",
      "preparation-interrupted",
      "delivery-unknown",
      "creation-unknown",
      "target-changed",
      "review-identity-changed",
      "evidence-missing",
      "brief-incomplete",
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

function validateLane(id: string, lane: unknown) {
  if (lane !== undefined && lane !== "light")
    throw new Error(`Invalid factory lane ${id}`);
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
  validateLane(id, run.lane);
  if (!validRunKind(run) || !validFullGate(run) || !/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error(`Invalid factory run ${id}`);
}

function validRunKind(run: Record<string, unknown>) {
  const validate =
    typeof run.kind === "string" && Object.hasOwn(runValidators, run.kind)
      ? runValidators[run.kind]
      : undefined;
  return validate?.(run) ?? false;
}

function validFullGate(run: Record<string, unknown>) {
  if (run.fullGate === undefined) return true;
  const gate = record(run.fullGate);
  const status = gate.status;
  if (
    !validDigest(gate.definition) ||
    gate.definition !== run.definition ||
    ![gate.base, gate.revision].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    ) ||
    typeof gate.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(gate.id) ||
    !timestamp(gate.landedAt)
  )
    return false;
  if (!fullGateMatchesRun(run, gate)) return false;
  const keys = ["definition", "base", "revision", "id", "landedAt", "status"];
  return validFullGateStatus(gate, status, keys);
}

function fullGateMatchesRun(
  run: Record<string, unknown>,
  gate: Record<string, unknown>,
) {
  if (run.kind !== "done") return gate.status === "failed";
  return (
    positiveInteger(run.attempt) &&
    gate.revision === run.revision &&
    gate.base === run.acceptedBase &&
    validLandingProof(run.landingProof) &&
    (gate.status === "passed"
      ? timestamp(run.acceptedAt)
      : run.acceptedAt === undefined && run.merge === undefined)
  );
}

function validLandingProof(value: unknown) {
  if (value === undefined) return true;
  const proof = record(value);
  return (
    exactKeys(proof, ["report", "gate"], ["review"]) &&
    validDigest(proof.report) &&
    validDigest(proof.gate) &&
    optionalFingerprint(proof.review)
  );
}

function validFullGateStatus(
  gate: Record<string, unknown>,
  status: unknown,
  keys: string[],
) {
  if (status === "running")
    return (
      exactKeys(gate, keys, ["process"]) &&
      (gate.process === undefined || validGateMarker(record(gate.process)))
    );
  if (status === "pending" || status === "interrupted")
    return exactKeys(gate, keys);
  if (status === "verified")
    return (
      exactKeys(gate, [...keys, "ledgerPr"], ["sha256"]) &&
      validFullGateReceipt(gate)
    );
  return (
    exactKeys(gate, [...keys, "exit"]) && validFullGateExit(status, gate.exit)
  );
}

function validFullGateReceipt(gate: Record<string, unknown>) {
  return positiveInteger(gate.ledgerPr) && optionalFingerprint(gate.sha256);
}

function validFullGateExit(status: unknown, exit: unknown) {
  if (status === "passed") return exit === 0;
  return (
    (status === "failed" || status === "stale") &&
    (exit === null || Number.isInteger(exit))
  );
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

function validAutomationRun(item: Record<string, unknown>) {
  return (
    (item.override === undefined || typeof item.override === "boolean") &&
    (item.lastRunAt === undefined || timestamp(item.lastRunAt)) &&
    ([undefined, "sent", "unknown"] as unknown[]).includes(item.lastOutcome)
  );
}

function validAutomation(item: Record<string, unknown>) {
  return (
    typeof item.schedule === "string" &&
    validCron(item.schedule) &&
    text(item.prompt) &&
    timestamp(item.armedAt) &&
    typeof item.authored === "boolean" &&
    validAutomationRun(item)
  );
}

function validateAutomations(value: unknown) {
  if (value === undefined) return;
  for (const entry of Object.values(record(value)))
    if (!validAutomation(record(entry)))
      throw new Error("Invalid factory automations");
}

function validateChildren(value: unknown, runs: unknown) {
  if (value === undefined) return;
  for (const [id, entry] of Object.entries(record(value))) {
    const child = record(entry);
    if (
      !thread(id) ||
      typeof child.ticket !== "string" ||
      !Object.hasOwn(record(runs), child.ticket) ||
      !["worker", "reviewer"].includes(String(child.role))
    )
      throw new Error("Invalid factory child identity");
  }
}

function validateForeman(value: unknown, runs: unknown) {
  if (value !== undefined) {
    const foreman = record(value);
    validateChildren(foreman.children, runs);
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
      }) ||
      !validObservers(foreman) ||
      (foreman.archives !== undefined &&
        !Object.entries(record(foreman.archives)).every(([id, value]) => {
          const archive = record(value);
          return (
            thread(id) &&
            timestamp(archive.at) &&
            thread(archive.owner) &&
            ["sending", "unknown", "archived"].includes(String(archive.outcome))
          );
        }))
    )
      throw new Error("Invalid Foreman records");
  }
}

function validObserver(value: unknown) {
  if (value === undefined) return true;
  const observer = record(value);
  return (
    thread(observer.thread) &&
    text(observer.model) &&
    text(observer.effort) &&
    timestamp(observer.at)
  );
}

function validObservers(foreman: Record<string, unknown>) {
  const retired = foreman.retiredObservers;
  return (
    validObserver(foreman.observer) &&
    (retired === undefined || (Array.isArray(retired) && retired.every(thread)))
  );
}

function stateRecord(value: unknown): State {
  const state = record(value);
  if (
    typeof state.enabled !== "boolean" ||
    (state.owner !== undefined && !thread(state.owner))
  )
    throw new Error("Invalid factory state");
  validateForeman(state.foreman, state.runs);
  validateMonitor(state.monitor);
  validateAutomations(state.automations);
  if (
    state.skippedTickets !== undefined &&
    (!Array.isArray(state.skippedTickets) ||
      !state.skippedTickets.every(
        (row) =>
          record(row) &&
          Object.keys(row).length === 2 &&
          text(row.file) &&
          text(row.reason),
      ))
  )
    throw new Error("Invalid factory skipped tickets");
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

function database(directory: string, readonly: boolean, check = "quick_check") {
  const db = new Database(join(directory, "state.sqlite"), {
    readonly,
    create: false,
    strict: true,
  });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version !== 1 && version !== 2)
      throw new Error(`Unsupported factory schema version ${version}`);
    const integrity = db.query(`PRAGMA ${check}`).values();
    if (integrity.length !== 1 || integrity[0]?.[0] !== "ok")
      throw new Error("Corrupt factory database");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Check a staged database's schema version and full SQLite integrity. @throws On invalid storage. */
export function restoredSchema(directory: string) {
  const db = database(directory, true, "integrity_check");
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
      .user_version;
  } finally {
    db.close();
  }
}

/** The durable hold installed alongside recovered database and evidence. */
export const restoreHoldFile = "restore-pending.json";
/** Records explicit initialization even if the database later disappears. */
export const initializedStateFile = "state-initialized";

/** Check for the local ownership hold without opening or changing SQLite. @throws On failed I/O. */
export function hasRestoreHold(directory: string) {
  return !!lstatSync(join(directory, restoreHoldFile), {
    throwIfNoEntry: false,
  });
}

/** Refuse replacement of any local data, including legacy files and SQLite journals.
 * @throws On existing storage, preparation failure or failed installation.
 */
export async function installFactoryStorage<T>(
  directory: string,
  prepare: (staged: string, temporary: string) => Promise<T>,
) {
  const local = lstatSync(directory, { throwIfNoEntry: false });
  if (local && (!local.isDirectory() || (await readdir(directory)).length))
    throw new Error("Refusing to replace existing local factory files");
  const temporary = await mkdtemp(join(dirname(directory), "factory-install-"));
  try {
    const staged = join(temporary, "factory");
    await mkdir(staged, { mode: 0o700 });
    const result = await prepare(staged, temporary);
    // A concurrent initializer or restore leaves a nonempty destination, which rename refuses.
    await rename(staged, directory);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// The `automations` field of the state, or nothing before the first load.
function readAutomations(db: Database) {
  const row = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automations'",
    )
    .get()
    ? db
        .query<{ data: string }, []>(
          "SELECT data FROM automations WHERE id = 1",
        )
        .get()
    : null;
  return row
    ? { automations: JSON.parse(row.data) as State["automations"] }
    : {};
}

function readSkipped(db: Database): SkippedTicket[] | undefined {
  const table = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skipped'",
    )
    .get();
  if (!table) return undefined;
  const row = db
    .query<{ data: string }, []>("SELECT data FROM skipped WHERE id = 1")
    .get();
  return row ? (JSON.parse(row.data) as SkippedTicket[]) : undefined;
}

function saveSkipped(db: Database, skipped: SkippedTicket[]) {
  db.run(
    "CREATE TABLE IF NOT EXISTS skipped (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
  );
  db.query("INSERT OR REPLACE INTO skipped (id, data) VALUES (1, ?)").run(
    JSON.stringify(skipped),
  );
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
  const skipped = readSkipped(db);
  return stateRecord({
    enabled: coordinator.enabled === 1,
    ...(coordinator.owner === null ? {} : { owner: coordinator.owner }),
    runs,
    ...(skipped ? { skippedTickets: skipped } : {}),
    ...(monitor ? { monitor: JSON.parse(monitor.data) } : {}),
    ...(foreman ? { foreman: JSON.parse(foreman.data) } : {}),
    ...readAutomations(db),
  });
}

// One declared automation over what was loaded before: the override survives only while the
// authored default is the one it was set over, and a newly enabled one is armed at `at`.
function mergedAutomation(
  declared: Automation,
  prev: AutomationRecord | undefined,
  at: number,
): AutomationRecord {
  const { schedule, prompt, enabled } = declared;
  const override = prev?.authored === enabled ? prev.override : undefined;
  const turnsOn = (override ?? enabled) && !(prev && automationEnabled(prev));
  return {
    ...prev,
    schedule,
    prompt,
    authored: enabled,
    override,
    armedAt: turnsOn ? at : (prev?.armedAt ?? at),
  };
}

/** The automations a definition's `declared` list yields over those already `before`, as
 * `definition(…, load)` saves them: overrides and last runs kept, a newly enabled one armed at `at`. */
export function mergedAutomations(
  declared: Automation[],
  before: Record<string, AutomationRecord>,
  at: number,
) {
  return Object.fromEntries(
    declared.map((automation) => [
      automation.name,
      mergedAutomation(automation, before[automation.name], at),
    ]),
  );
}

function saveAutomations(
  db: Database,
  automations: Record<string, AutomationRecord>,
) {
  db.run(
    "CREATE TABLE IF NOT EXISTS automations (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
  );
  db.query("INSERT OR REPLACE INTO automations (id, data) VALUES (1, ?)").run(
    JSON.stringify(automations),
  );
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
  if (state.skippedTickets) saveSkipped(db, state.skippedTickets);
  if (state.automations) saveAutomations(db, state.automations);
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

/** Record a diagnostic without creating or migrating storage. @throws On failed I/O. */
export function recordExistingFactoryEvent(directory: string, event: Event) {
  if (hasRestoreHold(directory) || !existsSync(join(directory, "state.sqlite")))
    return;
  const db = database(directory, false);
  try {
    saveEvent(db, event);
  } finally {
    db.close();
  }
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

/** Read curated SQLite tickets, state and review events in one snapshot; never import legacy files. @throws On invalid storage. */
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
      const reviews = db
        .query<Pick<Event, "ticket" | "action" | "detail">, []>(
          "SELECT ticket, action, detail FROM events WHERE action IN ('review-created', 'review-verdict') ORDER BY id",
        )
        .all();
      return { state, tickets, reviews, requests: readAutomationRequests(db) };
    })();
  } finally {
    db.close();
  }
}

function ticketEvidence(db: Database, directory: string, ticket: string) {
  if (!hasTable(db, "evidence")) return [];
  return db
    .query<EvidenceRecord, [string]>(
      `SELECT ${evidenceColumns} FROM evidence WHERE ticket = ? ORDER BY rowid`,
    )
    .all(ticket)
    .map((row) => ({ ...row, intact: intact(directory, row.sha256) }));
}

/** Read a known ticket's evidence records, verifying each preserved digest, without creating or changing storage. Returns null without durable storage and undefined for an unknown ticket. @throws On invalid storage. */
export function factoryEvidence(directory: string, ticket: string) {
  if (!existsSync(join(directory, "state.sqlite"))) return null;
  const db = database(directory, true);
  try {
    return db.transaction(() => {
      const known =
        db.query("SELECT 1 FROM tickets WHERE id = ?").get(ticket) ||
        db.query("SELECT 1 FROM runs WHERE ticket = ?").get(ticket);
      return known ? ticketEvidence(db, directory, ticket) : undefined;
    })();
  } finally {
    db.close();
  }
}

/** Read a ticket's recorded artifact content for the owner; never serve it publicly. @throws On missing storage, content the ticket never recorded, or missing or corrupt content. */
export function evidenceContent(
  directory: string,
  ticket: string,
  digest: string,
) {
  const found = factoryEvidence(directory, ticket)?.find(
    (row) => row.sha256 === digest,
  );
  if (!found) throw new Error("Unknown evidence identity");
  if (!found.intact) throw new Error("Evidence content missing or corrupt");
  return readFileSync(evidencePath(directory, found.sha256), "utf8");
}

function configuredTicket(
  task: Task,
  saved: Record<string, unknown> | undefined,
  replaceAdmitted: boolean,
) {
  const intake = saved ? ticketIntake(saved).intake : undefined;
  if (intake === "admitted" && !replaceAdmitted) return;
  return JSON.stringify({
    ...task,
    ...(intake ? { intake, outcome: task.outcome ?? saved!.outcome } : {}),
  });
}

function refreshTickets(
  db: Database,
  queue: Task[],
  now: () => number,
  replaceAdmitted = false,
) {
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
    const data = configuredTicket(task, saved, replaceAdmitted);
    if (data === undefined || previous?.data === data) continue;
    upsert.run(task.id, data);
    saveEvent(db, {
      at: new Date(now()).toISOString(),
      ticket: task.id,
      action: "configured",
      detail: data,
    });
  }
}

// A synced row vanishes only while nothing owns it: admission or any run freezes it in place.
function sweepSyncedTickets(
  db: Database,
  queue: Task[],
  state: State,
  now: () => number,
) {
  const synced = new Set(
    queue.flatMap((task) => (task.file === undefined ? [] : [task.id])),
  );
  for (const row of db
    .query<{ id: string; data: string }, []>("SELECT id, data FROM tickets")
    .all()) {
    const task = record(JSON.parse(row.data));
    const file = task.file;
    if (!text(file) || synced.has(row.id)) continue;
    if (task.intake === "admitted" || state.runs[row.id]) continue;
    db.query("DELETE FROM tickets WHERE id = ?").run(row.id);
    saveEvent(db, {
      at: new Date(now()).toISOString(),
      ticket: row.id,
      action: "removed",
      detail: file,
    });
  }
}

// One ticket-file sync inside the open transaction: sweep vanished rows and record the skip
// list when it changed, or clear a stale list once when the setting is gone.
function applyTicketSync(
  db: Database,
  queue: Task[],
  state: State,
  now: () => number,
  sync: { skipped: SkippedTicket[] } | "off",
) {
  if (sync === "off") {
    // The ticketFiles setting is gone; a stale skip list would misreport, so clear it once.
    if (!readSkipped(db)?.length) return;
    saveSkipped(db, []);
    saveEvent(db, {
      at: new Date(now()).toISOString(),
      ticket: "factory",
      action: "tickets-skipped",
      detail: "[]",
    });
    state.skippedTickets = [];
    return;
  }
  sweepSyncedTickets(db, queue, state, now);
  if (JSON.stringify(readSkipped(db) ?? []) !== JSON.stringify(sync.skipped)) {
    saveSkipped(db, sync.skipped);
    saveEvent(db, {
      at: new Date(now()).toISOString(),
      ticket: "factory",
      action: "tickets-skipped",
      detail: JSON.stringify(sync.skipped),
    });
  }
  state.skippedTickets = sync.skipped;
}

/** Open storage under the caller's poteto lock; migrate once. When `sync` is passed, rows that
 * synced from ticket files whose file is now gone are swept and the skip list is recorded;
 * both write events only when something actually changed. `"off"` means the ticketFiles
 * setting is absent, so a stale skip list from an earlier definition is cleared once; other
 * callers pass nothing and leave the list alone.
 * @throws On invalid storage or I/O. */
export function openPersistence(
  directory: string,
  queue: Task[],
  now: () => number = Date.now,
  sync?: { skipped: SkippedTicket[] } | "off",
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
      automationRequestTable(db);
      db.run(`CREATE TABLE IF NOT EXISTS native_hook_attempts (
        id TEXT PRIMARY KEY, definition TEXT NOT NULL, owner TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN
          ('claimed', 'refused', 'succeeded', 'failed', 'timed-out', 'uncertain')))`);
      db.run(`CREATE TABLE IF NOT EXISTS evidence (ticket TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0), kind TEXT NOT NULL,
        revision TEXT NOT NULL, definition TEXT, tool TEXT NOT NULL, outcome TEXT NOT NULL,
        sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (ticket, attempt, kind, revision, outcome, sha256))`);
      db.run(`CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, ticket TEXT NOT NULL,
        supersedes TEXT UNIQUE, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS lessons_project_ticket ON lessons(project, ticket);
        CREATE TABLE IF NOT EXISTS lesson_deliveries (
          lesson TEXT NOT NULL, thread TEXT NOT NULL, PRIMARY KEY (lesson, thread));
        CREATE TABLE IF NOT EXISTS lesson_project (
          id INTEGER PRIMARY KEY CHECK (id = 1), project TEXT NOT NULL);`);
      db.query("INSERT OR IGNORE INTO lesson_project VALUES (1, ?)").run(
        randomUUID(),
      );
      const state = readState(db);
      refreshTickets(db, queue, now);
      if (sync) applyTicketSync(db, queue, state, now, sync);
      return state;
    })();
    function hookEvent(id: string, outcome: HookOutcome | "claimed") {
      saveEvent(db, {
        at: new Date(now()).toISOString(),
        ticket: "factory",
        action: `hook-${outcome}`,
        detail: id,
      });
    }
    return {
      state,
      /** Reserve the native event once across owners, reloads and restarts. @throws On failed I/O. */
      claimHook(id: string, definition: string, owner: ThreadID) {
        return db.transaction(() => {
          const result = db
            .query(
              "INSERT INTO native_hook_attempts VALUES (?, ?, ?, 'claimed') ON CONFLICT (id) DO NOTHING",
            )
            .run(id, definition, owner);
          if (!result.changes) return false;
          hookEvent(id, "claimed");
          return true;
        })();
      },
      /** Settle a claimed event before publishing its outcome. @throws On a missing claim or failed I/O. */
      settleHook(id: string, outcome: HookOutcome) {
        db.transaction(() => {
          const result = db
            .query(
              "UPDATE native_hook_attempts SET outcome = ? WHERE id = ? AND outcome = 'claimed'",
            )
            .run(outcome, id);
          if (!result.changes) throw new Error("Missing unsettled hook claim");
          hookEvent(id, outcome);
        })();
      },
      /** Under the executor's same store lock, mark abandoned claims uncertain. @throws On failed I/O. */
      recoverHooks() {
        db.transaction(() => {
          const interrupted = db
            .query<{ id: string }, []>(
              "UPDATE native_hook_attempts SET outcome = 'uncertain' WHERE outcome = 'claimed' RETURNING id",
            )
            .all();
          for (const { id } of interrupted) hookEvent(id, "uncertain");
        })();
      },
      lessonProject: db
        .query<{ project: string }, []>(
          "SELECT project FROM lesson_project WHERE id = 1",
        )
        .get()!.project,
      /** Read dashboard intents oldest first under the coordinator lock. @throws On failed I/O. */
      automationRequests() {
        return readAutomationRequests(db);
      },
      /** Persist a request outcome before or after an effect. @throws On failed I/O. */
      settleAutomationRequest(
        id: number,
        status: "applied" | "refused",
        reason: string | null,
      ) {
        db.query(
          "UPDATE automation_requests SET status = ?, reason = ? WHERE id = ?",
        ).run(status, reason, id);
      },
      /** Save a validated immutable definition. Accepting it for future dispatch (`load`) also
       * replaces the loaded automations with `declared`, in the same transaction: each one keeps its
       * override while its authored default is unchanged, and its last run; one that turns on is
       * armed now, so the clock never fires for a time before it was on. An interruption leaves
       * the old definition with the old automations or the new with the new, never a mix.
       * @throws On storage failure.
       */
      definition(
        pin: DefinitionPin,
        load = false,
        declared: Automation[] = [],
      ) {
        const merged =
          load && (declared.length || state.automations)
            ? mergedAutomations(declared, state.automations ?? {}, now())
            : undefined;
        db.transaction(() => {
          db.query(
            "INSERT OR IGNORE INTO definitions (digest, data) VALUES (?, ?)",
          ).run(pin.digest, JSON.stringify(pin));
          if (load)
            db.query(
              "INSERT OR REPLACE INTO loaded_definition (id, digest) VALUES (1, ?)",
            ).run(pin.digest);
          if (merged) saveAutomations(db, merged);
        })();
        if (merged) state.automations = merged;
      },
      /** Release only brief refusals for rechecking, retaining admitted intake. @throws On storage failure. */
      reloadBriefs() {
        const refused = queue.filter((task) => {
          const run = state.runs[task.id];
          return (
            run?.kind === "blocked" &&
            run.incident?.reason === "brief-incomplete"
          );
        });
        if (!refused.length) return;
        db.transaction(() => {
          refreshTickets(db, refused, now, true);
          for (const task of refused) {
            delete state.runs[task.id];
            saveEvent(db, {
              at: new Date(now()).toISOString(),
              ticket: task.id,
              action: "brief-reloaded",
              detail: "Brief refusal released for dispatch validation",
            });
          }
          saveState(db, state);
        })();
      },
      tickets: db
        .query<{ data: string }, []>("SELECT data FROM tickets ORDER BY rowid")
        .all()
        .map((row) => {
          const task = JSON.parse(row.data) as Task;
          taskSteps(task.steps);
          ticketIntake(record(task));
          if (task.lessonScope !== undefined) taskLessonScope(task.lessonScope);
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
            !task.after.every((dependency) =>
              fullyVerified(state.runs[dependency]),
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
      /** Read the ticket's evidence bound to one attempt and revision, verifying each digest. @throws On storage failure. */
      proof(ticket: string, attempt: number, revision: string) {
        return ticketEvidence(db, directory, ticket).filter(
          (row) => row.attempt === attempt && row.revision === revision,
        );
      },
      /** Record one immutable phase summary per source revision. @throws On unsafe, conflicting or unverified input. */
      recordLesson(
        value: unknown,
        authorize?: (lesson: PhaseLesson) => void,
      ): SavedLesson {
        const lesson = parseLesson(value);
        authorize?.(lesson);
        const { project, ticket, phase, supersedes } = lesson;
        const id = lessonIdentity(lesson);
        return db.transaction(() => {
          const history = lessonHistory(db, project, ticket);
          const saved = history.find((item) => item.id === id);
          const entry = { ...lesson, id };
          if (saved) {
            if (!isDeepStrictEqual(saved, entry))
              throw new Error("Conflicting phase lesson");
            return saved;
          }
          if (!lessonProof(db, lesson, (digest) => intact(directory, digest)))
            throw new Error(
              "Missing intact lesson evidence for this attempt and revision",
            );
          if (
            supersedes &&
            (!history.some(
              (item) =>
                item.id === supersedes &&
                item.phase === phase &&
                isDeepStrictEqual(item.scope, lesson.scope),
            ) ||
              history.some((item) => item.supersedes === supersedes))
          )
            throw new Error("Invalid lesson supersession");
          db.query(
            "INSERT INTO lessons (id, project, ticket, supersedes, data) VALUES (?, ?, ?, ?, ?)",
          ).run(
            id,
            project,
            ticket,
            supersedes ?? null,
            JSON.stringify(lesson),
          );
          return entry;
        })();
      },
      /** Return source history, including superseded records. @throws On invalid storage. */
      lessons(project: string, ticket: string) {
        return lessonHistory(db, project, ticket);
      },
      /** Return at most three intact, still-current findings for a worker. @throws On invalid storage. */
      relevantLessons(
        project: string,
        ticket: string,
        after: string[],
        scope: string[],
        target: ThreadID,
      ) {
        const rows = db
          .query<{ id: string; data: string }, [string, string, string]>(
            `
          SELECT l.id, l.data FROM lessons l WHERE l.project = ? AND l.ticket != ?
            AND NOT EXISTS (SELECT 1 FROM lessons newer WHERE newer.supersedes = l.id)
            AND NOT EXISTS (SELECT 1 FROM lesson_deliveries d WHERE d.lesson = l.id AND d.thread = ?)
            ORDER BY l.rowid DESC
        `,
          )
          .iterate(project, ticket, target);
        const selected: SavedLesson[] = [];
        for (const { id, data } of rows) {
          const lesson = parseLesson(JSON.parse(data));
          if (
            lesson.findings.length &&
            (after.includes(lesson.ticket) ||
              lesson.scope.some((a) =>
                scope.some((b) => overlapsLessonScope(a, b)),
              )) &&
            lessonProof(db, lesson, (digest) => intact(directory, digest))
          )
            selected.push({ ...lesson, id });
          if (selected.length === 3) break;
        }
        return selected;
      },
      /** Reserve one standalone delivery before calling Amp. @throws On storage failure. */
      reserveLesson(id: string, target: ThreadID) {
        return reserveLesson(db, id, target);
      },
      /** Read an already reserved finding before repeating a handoff. @throws On invalid storage. */
      currentLesson(id: string): SavedLesson | undefined {
        const row = db
          .query<{ data: string }, [string]>(
            `SELECT data FROM lessons WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM lessons WHERE supersedes = ?1)`,
          )
          .get(id);
        if (!row) return undefined;
        const lesson = parseLesson(JSON.parse(row.data));
        return lessonProof(db, lesson, (digest) => intact(directory, digest))
          ? { ...lesson, id }
          : undefined;
      },
      /** Preserve evidence for a fact that has no state transition of its own, such as a gate run before its rerun; repeats write nothing. @throws On invalid or conflicting evidence or failed preservation. */
      record(ticket: string, evidence: Evidence[]) {
        const records = preparedEvidence(directory, ticket, evidence, now());
        db.transaction(() => {
          for (const record of records) saveEvidence(db, record);
        })();
      },
      /** Persist state, its event and the evidence the decision used together, stamping each run that changed stage. Content is preserved and verified first; an identity is written once. @throws On invalid or conflicting evidence or transaction failure; all roll back. */
      commit(
        state: State,
        ticket: string,
        action: string,
        detail: string,
        evidence: Evidence[] = [],
        handoff?: { thread: ThreadID; lessons: SavedLesson[] },
      ) {
        const at = now();
        const records = preparedEvidence(directory, ticket, evidence, at);
        db.transaction(() => {
          const saved = new Map(
            db
              .query<{ ticket: string; data: string }, []>(
                "SELECT ticket, data FROM runs",
              )
              .all()
              .map((row) => [row.ticket, JSON.parse(row.data) as Run]),
          );
          for (const [id, run] of Object.entries(state.runs)) {
            const before = saved.get(id);
            const stageAt =
              before && runStage(before).stage === runStage(run).stage
                ? before.stageAt
                : at;
            if (stageAt === undefined) delete run.stageAt;
            else run.stageAt = stageAt;
          }
          saveState(db, state);
          saveEvent(db, {
            at: new Date(at).toISOString(),
            ticket,
            action,
            detail,
          });
          for (const record of records) saveEvidence(db, record);
          if (handoff)
            for (const lesson of handoff.lessons)
              reserveLesson(db, lesson.id, handoff.thread);
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
