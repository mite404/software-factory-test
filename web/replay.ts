// Dev feed for the pipeline view. Serves GET /api/status from a recorded sequence, so the page can
// be worked on with no factory running. Not factory output: the sequence was observed on the
// dogfood factory's feed on 2026-11-13 and 14, then trimmed to the fields the page reads.
// Run: `amp orb services ensure`, or `PORT=4311 bun web/replay.ts`.
import type { DashboardEvent, DashboardEvidence } from "../factory/dashboard";
import type { Feed, FeedTask } from "./derive";
import { pipelineSteps } from "../factory/pipeline";
import { lifecycleStatus, stages } from "../factory/persistence";

// Illustrative event rows alongside the recorded status polls, not a private log export.
const EVENTS: DashboardEvent[] = [
  {
    id: 1,
    at: "2026-11-13T23:20:00Z",
    ticket: "v1-ticket1",
    action: "accepted",
    revision: "af0ae26".padEnd(40, "0"),
  },
  {
    id: 2,
    at: "2026-11-13T23:21:00Z",
    ticket: "backup-adoption-ticket1",
    action: "created",
    thread: "T-replay-2",
  },
  {
    id: 3,
    at: "2026-11-13T23:22:00Z",
    ticket: "backup-adoption-ticket1",
    action: "sent",
    thread: "T-replay-2",
  },
  {
    id: 4,
    at: "2026-11-13T23:26:14Z",
    ticket: "backup-adoption-ticket1",
    action: "review-sent",
    attempt: 5,
    thread: "T-replay-review",
  },
  {
    id: 5,
    at: "2026-11-13T23:33:28Z",
    ticket: "backup-adoption-ticket1",
    action: "rejected",
    attempt: 5,
    reason: "review-rejected",
  },
  {
    id: 6,
    at: "2026-11-13T23:45:44Z",
    ticket: "backup-adoption-ticket1",
    action: "review-sent",
    attempt: 6,
    thread: "T-replay-review",
  },
  {
    id: 7,
    at: "2026-11-13T23:53:45Z",
    ticket: "backup-adoption-ticket1",
    action: "accepted",
  },
  {
    id: 8,
    at: "2026-11-14T00:01:27Z",
    ticket: "v1-ticket2",
    action: "creating",
  },
  {
    id: 9,
    at: "2026-11-14T00:02:35Z",
    ticket: "v1-ticket2",
    action: "blocked",
  },
  {
    id: 10,
    at: "2026-11-14T01:47:42Z",
    ticket: "v1-ticket2",
    action: "repair-resumed",
    attempt: 2,
    thread: "T-replay-3",
  },
];

/** Cursor-limited illustrative events for the local replay, growing without wrapping IDs. */
export function eventsAt(
  poll: number,
  after = 0,
  limit = 100,
): DashboardEvent[] {
  return EVENTS.slice(0, 3 + Math.max(0, poll))
    .filter((event) => event.id > after)
    .slice(0, limit);
}

// Real tickets in feed order. attempt is the cold review attempt each landed on, null for none.
const TICKETS = [
  {
    id: "feature-06",
    steps: [],
    revision: "cd75e02",
    attempt: null,
    merge: null,
  },
  {
    id: "v1-ticket1",
    steps: [
      "Reproduce public brief disclosure",
      "Separate titles from briefs",
      "Verify every title state",
    ],
    revision: "af0ae26",
    attempt: 1,
    merge: {
      pr: 3,
      url: "https://github.com/mite404/software-factory-test/pull/3",
    },
  },
  {
    id: "backup-adoption-ticket1",
    steps: [
      "Inspect preserved backup candidate",
      "Adopt shared snapshot operation",
      "Verify publication uncertainty controls",
    ],
    revision: "b649c8a",
    attempt: 6,
    merge: { pr: 3, url: null },
  },
  {
    id: "v1-ticket2",
    steps: [
      "Define authoritative project settings",
      "Migrate only on request",
      "Pin future run definitions",
    ],
    revision: null,
    attempt: null,
    merge: null,
  },
];

// One poll each: the newest ticket in the feed, its stage and activity, and its pending review.
// Stages were not in the 2026-11 recording; frames 15 to 18 are illustrative stage examples, and
// frames 19 to 22 are the lifecycle graph's cases: an empty factory, one running ticket, one
// stopped ticket and several tickets on one state. Frame 23 is a gate rejection on its way back
// to the same builder. Every frame names the run's kind, and its stop when one holds it, as keys
// of the declared table.
type Frame = {
  ticket: number; // index of the newest ticket; -1 is an empty factory
  kind: string | null;
  stopName?: string;
  crowd?: true; // every ticket up to `ticket` is in this frame's state, none landed
  activity?: FeedTask["activity"]; // the observed activity of a run in flight
  stage: NonNullable<FeedTask["stage"]>;
  actor: NonNullable<FeedTask["actor"]>;
  pending?: number;
  stopped?: boolean;
  parked?: boolean;
  escalated?: boolean;
  repair?: true; // the gate rejected attempt 1 and the repair message is not sent yet
};

const BUILDING = {
  stage: "building",
  actor: "model",
  kind: "running",
} as const;
const REVIEWING = {
  stage: "reviewing",
  actor: "model",
  kind: "running",
} as const;

export const FRAMES: Frame[] = [
  { ticket: 2, activity: "working", ...BUILDING },
  { ticket: 2, activity: "blocked", pending: 5, ...REVIEWING }, // 23:26:14 review dispatch reads "blocked"
  { ticket: 2, activity: "working", pending: 5, ...REVIEWING },
  { ticket: 2, activity: "working", ...BUILDING }, // 23:33:28 review record gone: rejected, same worker repairs
  { ticket: 2, activity: "blocked", pending: 6, ...REVIEWING }, // 23:45:44
  { ticket: 2, activity: "working", pending: 6, ...REVIEWING },
  {
    ticket: 2,
    stage: "accepted",
    actor: "foreman",
    kind: "done",
  }, // 23:53:45 landed on attempt 6
  {
    ticket: 3,
    stage: "creating",
    actor: "computer",
    kind: "creating",
  }, // 00:01:27 next ticket appears
  { ticket: 3, activity: "working", ...BUILDING },
  {
    ticket: 3,
    stage: "blocked",
    actor: "foreman",
    kind: "blocked",
  }, // 00:02:35 blocked before any review, for 1 h 45 min
  { ticket: 3, activity: "idle", ...BUILDING }, // 01:47:42 resumed by the foreman
  { ticket: 3, ...BUILDING },
  { ticket: 3, activity: "working", ...BUILDING },
  {
    ticket: 3,
    activity: "blocked",
    pending: 2,
    stopped: true,
    stage: "reviewing",
    actor: "foreman",
    kind: "running",
    stopName: "reviewerError",
  },
  {
    ticket: 3,
    stopped: true,
    parked: true,
    stage: "parked",
    actor: "operator",
    kind: "parked",
    stopName: "repair",
  },
  {
    ticket: 3,
    stage: "gating",
    actor: "computer",
    kind: "running",
  },
  { ticket: 3, pending: 5, ...REVIEWING },
  {
    ticket: 3,
    stopped: true,
    escalated: true,
    stage: "escalated",
    actor: "foreman",
    kind: "blocked",
    stopName: "repair",
  },
  {
    ticket: 3,
    stage: "rate-limited",
    actor: "computer",
    kind: "running",
    stopName: "providerLimit",
  },
  {
    ticket: -1,
    stage: "queued",
    actor: "computer",
    kind: null,
  },
  { ticket: 0, activity: "working", ...BUILDING },
  {
    ticket: 0,
    stopped: true,
    parked: true,
    stage: "parked",
    actor: "operator",
    kind: "parked",
    stopName: "repair",
  },
  { ticket: 3, activity: "working", crowd: true, ...BUILDING },
  { ticket: 3, activity: "working", repair: true, ...BUILDING },
  {
    ticket: 3,
    stage: "disconnected",
    actor: "operator",
    kind: "running",
    stopName: "disconnected",
  },
];

const STOPPED_REVIEW = {
  stop: {
    reason: "worker-error",
    role: "reviewer",
    thread: "T-replay-review-2",
  },
  rejections: [{ attempt: 1, thread: "T-replay-review-1" }],
} satisfies Partial<FeedTask>;

const PARKED_REVIEW = {
  attempt: 4,
  reviewerThread: null,
  evidence: { review: null },
  stop: {
    reason: "verification-rejected",
    role: "reviewer",
    thread: "T-replay-review-4",
  },
  rejections: [
    { attempt: 1, thread: "T-replay-review-1" },
    { attempt: 2, thread: "T-replay-review-2" },
    { attempt: 3, thread: "T-replay-review-3" },
    { attempt: 4, thread: "T-replay-review-4" },
  ],
} satisfies Partial<FeedTask>;

const ESCALATED_REVIEW = {
  ...PARKED_REVIEW,
  attempt: 6,
  stop: { ...PARKED_REVIEW.stop, thread: "T-replay-review-6" },
} satisfies Partial<FeedTask>;

const PROVIDER_LIMIT = {
  stop: { reason: "provider-limit", role: "worker", thread: "T-replay-3" },
  rejections: [],
} satisfies Partial<FeedTask>;

const GATE_REPAIR = {
  attempt: 2,
  repair: { reason: "gate-failed", attempt: 1 },
  checks: {
    attempt: 1,
    results: [
      { name: "test", required: true, status: "pass" },
      { name: "lint", required: true, status: "fail" },
      { name: "typecheck", required: true, status: "pass" },
      { name: "fallow", required: false, status: "fail" },
    ],
  },
} satisfies Partial<FeedTask>;

function stopFrame(frame: Frame): Partial<FeedTask> {
  if (frame.stopName === "providerLimit") return PROVIDER_LIMIT;
  if (frame.stopName === "disconnected")
    return {
      stop: { reason: "disconnected", role: "worker", thread: "T-replay-3" },
    };
  if (frame.parked) return PARKED_REVIEW;
  return frame.escalated ? ESCALATED_REVIEW : STOPPED_REVIEW;
}

// The pipeline step index each replayed stage sits at; stopped reviews sit at cold review.
const STEP: Partial<Record<Frame["stage"], number>> = {
  creating: 2,
  building: 2,
  blocked: 2,
  "rate-limited": 2,
  disconnected: 2,
  gating: 4,
  reviewing: 5,
  escalated: 5,
  parked: 5,
};

const STOPPED_AT = "2026-11-14T01:47:42.000Z";

// Landed tickets read merged once a merge is recorded; the active ticket reads its frame.
function stageFrame(
  frame: Frame,
  landed: boolean,
  merged: boolean,
): Partial<FeedTask> & Pick<FeedTask, "stage"> {
  if (!landed)
    return {
      stage: frame.stage,
      actor: frame.actor,
      step: STEP[frame.stage] ?? null,
      rejectedBy:
        frame.stopped && frame.stage !== "reviewing"
          ? "review"
          : frame.repair
            ? "gate"
            : null,
      clearsAt:
        frame.stage === "rate-limited"
          ? new Date(Date.now() + 25 * 60_000).toISOString()
          : null,
      kind: frame.kind,
      stopName: frame.stopName ?? null,
      stageSince: STOPPED_AT,
    };
  const summary = "Landed after its recorded checks";
  const done = {
    kind: "done",
    stopName: null,
    stageSince: STOPPED_AT,
    summary,
  };
  return merged
    ? { ...done, stage: "merged", actor: null, step: 6 }
    : { ...done, stage: "accepted", actor: "foreman", step: 6 };
}

function reviewFrame(
  attempt: number | null | undefined,
  landed: boolean,
  revision: string | null,
) {
  const completed = !!attempt && landed;
  return {
    reviewerThread: attempt ? `T-replay-review-${attempt}` : null,
    attempt: attempt ?? null,
    evidence: {
      review: attempt ? { pending: !landed, attempt } : null,
      acceptance: landed ? { revision } : null,
    },
    reviewDecision: completed ? { outcome: "pass" as const, attempt } : null,
    revision: attempt || landed ? revision : null,
  };
}

const landedIn = (frame: Frame, i: number) =>
  !frame.crowd && (i < frame.ticket || frame.stage === "accepted");

const stoppedIn = (frame: Frame, landed: boolean) =>
  !landed && (frame.stopped || !!frame.stopName);

function outcomeFrame(
  frame: Frame,
  ticket: (typeof TICKETS)[number],
  landed: boolean,
) {
  return {
    activity: landed ? null : (frame.activity ?? null),
    parked: !landed && frame.parked === true,
    merge: landed ? ticket.merge : null,
  } as const;
}

function taskAt(frame: Frame, ticket: (typeof TICKETS)[number], i: number) {
  const landed = landedIn(frame, i);
  return {
    id: ticket.id,
    title: ticket.id,
    steps: ticket.steps,
    thread: `T-replay-${i}`,
    workerThread: `T-replay-${i}`,
    ...reviewFrame(
      landed ? ticket.attempt : frame.pending,
      landed,
      ticket.revision,
    ),
    stop: null,
    repair: null,
    rejections: [],
    ...(stoppedIn(frame, landed) ? stopFrame(frame) : {}),
    ...(frame.repair && !landed ? GATE_REPAIR : {}),
    ...stageFrame(frame, landed, !!ticket.merge),
    ...outcomeFrame(frame, ticket, landed),
  };
}

/**
 * The feed as the dashboard would serve it at one recorded poll.
 * @param n Poll number; wraps around the recording.
 */
export function feedAt(n: number): Feed {
  const frame = FRAMES[n % FRAMES.length]!;
  return {
    project: "recorded replay, illustrative events, not a live factory",
    sample: true,
    target: "main",
    observedAt: new Date().toISOString(),
    enabled: true,
    fresh: true,
    pipelineSteps,
    lifecycle: lifecycleStatus(),
    stages,
    automations: [
      {
        name: "sample-audit",
        schedule: n % 4 === 3 ? null : "0 9 * * 1",
        enabled: n % 4 === 0,
        lastRunAt: n % 4 === 3 ? null : Date.parse("2026-11-19T09:00:00Z"),
        lastOutcome: n % 4 === 3 ? null : "sent",
        requests:
          n % 4 < 2
            ? []
            : [
                {
                  id: 1,
                  name: "sample-audit",
                  action: "run",
                  at: Date.parse("2026-11-19T10:00:00Z"),
                  ...(n % 4 === 2
                    ? ({ status: "pending", reason: null } as const)
                    : ({
                        status: "refused",
                        reason: "Error: Unknown automation sample-audit",
                      } as const)),
                },
              ],
      },
    ],
    tasks: TICKETS.slice(0, frame.ticket + 1).map((ticket, i) =>
      taskAt(frame, ticket, i),
    ),
  };
}

if (import.meta.main) {
  // ponytail: each request advances the recording, so two open tabs share and skip frames.
  // Advance on a timer if several viewers ever need the same replay.
  let poll = 0;
  Bun.serve({
    port: Number(process.env.PORT ?? 4311),
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/status") return Response.json(feedAt(poll++));
      if (url.pathname === "/api/evidence") {
        const ticket = url.searchParams.get("ticket");
        const evidence: DashboardEvidence[] =
          ticket === "v1-ticket1"
            ? [
                {
                  attempt: 1,
                  kind: "gate",
                  revision: "a".repeat(40),
                  outcome: "gate-passed",
                  definition: "b".repeat(64),
                  sha256: "c".repeat(64),
                  bytes: 128,
                  at: "2026-11-13T23:19:00Z",
                  preserved: true,
                },
              ]
            : [];
        return Response.json({ durable: "available", ticket, evidence });
      }
      if (url.pathname === "/api/events")
        return Response.json({
          durable: "available",
          events: eventsAt(
            poll,
            Number(url.searchParams.get("after") ?? 0),
            Number(url.searchParams.get("limit") ?? 100),
          ),
        });
      return new Response("Not found", { status: 404 });
    },
  });
}
