// Dev feed for the pipeline view. Serves GET /api/status from a recorded sequence, so the page can
// be worked on with no factory running. Not factory output: the sequence was observed on the
// dogfood factory's feed on 2026-11-13 and 14, then trimmed to the fields the page reads.
// Run: `amp orb services ensure`, or `PORT=4311 bun web/replay.ts`.
import type { DashboardEvent } from "../factory/dashboard";
import type { Feed, FeedTask } from "./derive";
import { pipelineSteps } from "../factory/pipeline";

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

// One poll each: the newest ticket in the feed, its status, and its pending review attempt.
type Frame = {
  ticket: number;
  status: FeedTask["status"];
  pending?: number;
  stopped?: boolean;
  parked?: boolean;
};

export const FRAMES: Frame[] = [
  { ticket: 2, status: "working" },
  { ticket: 2, status: "blocked", pending: 5 }, // 23:26:14 review dispatch reads "blocked"
  { ticket: 2, status: "working", pending: 5 },
  { ticket: 2, status: "working" }, // 23:33:28 review record gone: rejected, same worker repairs
  { ticket: 2, status: "blocked", pending: 6 }, // 23:45:44
  { ticket: 2, status: "working", pending: 6 },
  { ticket: 2, status: "accepted" }, // 23:53:45 landed on attempt 6
  { ticket: 3, status: "unknown" }, // 00:01:27 next ticket appears
  { ticket: 3, status: "working" },
  { ticket: 3, status: "blocked" }, // 00:02:35 blocked before any review, for 1 h 45 min
  { ticket: 3, status: "idle" }, // 01:47:42 resumed by the foreman
  { ticket: 3, status: "unknown" },
  { ticket: 3, status: "working" },
  { ticket: 3, status: "blocked", pending: 2, stopped: true },
  { ticket: 3, status: "blocked", stopped: true, parked: true },
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

function reviewFrame(
  attempt: number | null | undefined,
  landed: boolean,
  revision: string | null,
) {
  return {
    reviewerThread: attempt ? `T-replay-review-${attempt}` : null,
    attempt: attempt ?? null,
    evidence: { review: attempt ? { pending: !landed, attempt } : null },
    revision: attempt || landed ? revision : null,
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
    target: "main",
    observedAt: new Date().toISOString(),
    enabled: true,
    fresh: true,
    pipelineSteps,
    tasks: TICKETS.slice(0, frame.ticket + 1).map((ticket, i) => {
      const landed = i < frame.ticket || frame.status === "accepted";
      const attempt = landed ? ticket.attempt : frame.pending;
      const stopped = !landed && frame.stopped;
      return {
        id: ticket.id,
        title: ticket.id,
        steps: ticket.steps,
        status: landed ? "accepted" : frame.status,
        thread: `T-replay-${i}`,
        workerThread: `T-replay-${i}`,
        ...reviewFrame(attempt, landed, ticket.revision),
        stop: null,
        rejections: [],
        ...(stopped ? (frame.parked ? PARKED_REVIEW : STOPPED_REVIEW) : {}),
        parked: !landed && frame.parked === true,
        merge: landed ? ticket.merge : null,
      };
    }),
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
