// Dev feed for the pipeline view. Serves GET /api/status from a recorded sequence, so the page can
// be worked on with no factory running. Not factory output: the sequence was observed on the
// dogfood factory's feed on 2026-11-13 and 14, then trimmed to the fields the page reads.
// Run: `amp orb services ensure`, or `PORT=4311 bun web/replay.ts`.
import type { Feed, Task } from "./derive";

// Real tickets in feed order. attempt is the cold review attempt each landed on, null for none.
const TICKETS = [
  { id: "feature-06", steps: [], revision: "cd75e02", attempt: null },
  {
    id: "v1-ticket1",
    steps: [
      "Reproduce public brief disclosure",
      "Separate titles from briefs",
      "Verify every title state",
    ],
    revision: "af0ae26",
    attempt: 1,
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
  },
];

// One poll each: the newest ticket in the feed, its status, and its pending review attempt.
type Frame = { ticket: number; status: Task["status"]; pending?: number };

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
];

/**
 * The feed as the dashboard would serve it at one recorded poll.
 * @param n Poll number; wraps around the recording.
 */
export function feedAt(n: number): Feed {
  const frame = FRAMES[n % FRAMES.length]!;
  return {
    project: "recorded replay, not a live factory",
    target: "main",
    observedAt: new Date().toISOString(),
    enabled: true,
    fresh: true,
    tasks: TICKETS.slice(0, frame.ticket + 1).map((ticket, i) => {
      const landed = i < frame.ticket || frame.status === "accepted";
      const attempt = landed ? ticket.attempt : frame.pending;
      return {
        id: ticket.id,
        title: ticket.id,
        steps: ticket.steps,
        status: landed ? "accepted" : frame.status,
        thread: null,
        revision: attempt || landed ? ticket.revision : null,
        evidence: { review: attempt ? { pending: !landed, attempt } : null },
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
    fetch: (request) =>
      new URL(request.url).pathname === "/api/status"
        ? Response.json(feedAt(poll++))
        : new Response("Not found", { status: 404 }),
  });
}
