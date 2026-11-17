import { expect, test } from "bun:test";
import {
  derive,
  eventBatch,
  eventRows,
  type Feed,
  type FeedTask,
} from "./derive";
import { eventsAt, feedAt, FRAMES } from "./replay";
import { pipelineSteps } from "../factory/pipeline";

const NOW = Date.parse("2026-11-13T12:00:10Z");

function feed(statuses: FeedTask["status"][], extra: Partial<Feed> = {}): Feed {
  return {
    project: "p",
    target: "main",
    observedAt: "2026-11-13T12:00:03Z",
    enabled: true,
    fresh: true,
    tasks: statuses.map((status, i) => ({
      id: `T${i + 1}`,
      title: `ticket ${i + 1}`,
      steps: [],
      status,
      thread: status === "working" ? "T-abc" : null,
      revision: status === "accepted" ? `${i + 1}`.repeat(40) : null,
    })),
    ...extra,
  };
}

test("stage actors and links follow the feed and the recorded failed role", () => {
  const raw = feed(["blocked"], { pipelineSteps });
  raw.tasks[0] = {
    ...raw.tasks[0]!,
    workerThread: "T-builder",
    reviewerThread: "T-current",
    stop: { reason: "worker-error", role: "reviewer", thread: "T-failed" },
    rejections: [{ attempt: 1, thread: "T-earlier" }],
  };
  const ticket = derive(null, raw, NOW).tickets[0]!;
  expect(ticket.steps).toEqual([
    "done",
    "done",
    "done",
    "done",
    "done",
    "fail",
    "",
  ]);
  expect(ticket.stageLinks).toEqual([
    null,
    null,
    "https://ampcode.com/threads/T-builder",
    "https://ampcode.com/threads/T-builder",
    null,
    "https://ampcode.com/threads/T-failed",
    null,
  ]);
  expect(ticket.rejections).toEqual([
    { attempt: 1, href: "https://ampcode.com/threads/T-earlier" },
  ]);
  expect(
    derive(null, { ...raw, pipelineSteps: pipelineSteps.slice(0, 3) }, NOW)
      .tickets[0]!.steps,
  ).toHaveLength(3);
  for (const reason of ["target-changed", "review-identity-changed"] as const) {
    const unknown = derive(
      null,
      {
        ...raw,
        tasks: [
          { ...raw.tasks[0]!, stop: { reason, role: null, thread: null } },
        ],
      },
      NOW,
    ).tickets[0]!;
    expect(unknown.stageLinks[unknown.steps.indexOf("fail")]).toBeNull();
    expect(unknown.stageLinks[2]).toBe("https://ampcode.com/threads/T-builder");
  }
  for (const thread of ["T-escape\n", "https://evil.test", "T-../escape"]) {
    raw.tasks[0]!.stop!.thread = thread;
    raw.tasks[0]!.workerThread = thread;
    raw.tasks[0]!.rejections![0]!.thread = thread;
    const invalid = derive(null, raw, NOW).tickets[0]!;
    expect(invalid.stageLinks.filter(Boolean)).toEqual([]);
    expect(invalid.stop?.href).toBeNull();
    expect(invalid.rejections[0]!.href).toBeNull();
  }
});

test("ticket links are built only from validated thread and merge parts", () => {
  const raw = feed(["accepted"]);
  const task = raw.tasks[0]!;
  task.thread = "T-worker_123";
  task.merge = { pr: 42, url: "https://github.com/owner/repo.name/pull/42" };
  const view = derive(null, raw, NOW);
  expect(view.tickets[0]).toMatchObject({
    href: "https://ampcode.com/threads/T-worker_123",
    pullRequest: {
      number: 42,
      href: "https://github.com/owner/repo.name/pull/42",
    },
  });
  expect(view.main[0]!.href).toBe("https://ampcode.com/threads/T-worker_123");
  for (const url of [
    "https://evil.test/owner/repo/pull/42",
    "http://github.com/owner/repo/pull/42",
    "https://github.com/owner/repo/pull/42/files",
    "https://github.com/owner/repo/pull/42?next=evil",
    "https://github.com/owner/repo/pull/42#fragment",
    "https://github.com@evil.test/owner/repo/pull/42",
    "https://github.com/owner/../pull/42",
    "https://github.com/owner/repo/pull/43",
    "https://github.com/owner/repo/pull/042",
    "https://github.com/owner/repo/pull/42\n",
    null,
  ]) {
    task.merge = { pr: 42, url };
    expect(derive(null, raw, NOW).tickets[0]!.pullRequest).toEqual({
      number: 42,
      href: null,
    });
  }
  for (const pr of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    task.merge = { pr, url: `https://github.com/owner/repo/pull/${pr}` };
    expect(derive(null, raw, NOW).tickets[0]!.pullRequest).toBeNull();
  }
  task.merge = null;
  for (const thread of [null, "https://evil.test", "T-../evil", "T-worker\n"]) {
    task.thread = thread;
    const ticket = derive(null, raw, NOW).tickets[0]!;
    expect(ticket.href).toBeNull();
    expect(ticket.pullRequest).toBeNull();
  }
});

test("only a queued or blocked ticket that starts work gets a foreman hand-off", () => {
  const view = derive(
    feed(["idle", "queued"]),
    feed(["working", "working"]),
    NOW,
  );
  expect(view.startRow).toBe(2);
  expect(derive(null, feed(["working"]), NOW).startRow).toBe(0);
  // Real sequence from backup-adoption-ticket1 at 22:43:43: the foreman resumes a blocked ticket.
  const resumed = derive(
    feed(["accepted", "blocked"]),
    feed(["accepted", "working"]),
    NOW,
  );
  expect(resumed.startRow).toBe(1);
  // A review dispatch reads "blocked" in the feed but is work in progress: no hand-off after it.
  const dispatching = feed(["accepted", "blocked"]);
  dispatching.tasks[1]!.evidence = { review: { pending: true } };
  expect(derive(dispatching, feed(["accepted", "working"]), NOW).startRow).toBe(
    0,
  );
});

test("a ticket that lands keeps its builder row for one poll, then leaves", () => {
  const before = feed(["accepted", "idle", "working", "queued"]);
  const after = feed(["accepted", "accepted", "blocked", "queued"]);

  const landingPoll = derive(before, after, NOW);
  expect(landingPoll.landed).toBe(true);
  expect(landingPoll.reviewed).toBe(false); // no review record: straight to main
  after.tasks[1]!.evidence = { review: { pending: false } };
  expect(derive(before, after, NOW).reviewed).toBe(true);
  after.tasks[0]!.evidence = after.tasks[1]!.evidence; // an older landing's review does not count
  after.tasks[1]!.evidence = { review: null };
  expect(derive(before, after, NOW).reviewed).toBe(false);
  expect(landingPoll.outRow).toBe(1);
  expect(landingPoll.backRow).toBe(2);
  expect(landingPoll.builders.map((c) => c.id)).toEqual(["T2", "T3", "T4", ""]);
  expect(landingPoll.builders.map((c) => c.status)).toEqual([
    "accepted",
    "blocked",
    "queued",
    "empty",
  ]);
  expect(landingPoll.main.map((d) => [d.on, d.last])).toEqual([
    [true, true],
    [true, false],
    ...Array.from({ length: 5 }, () => [false, false]),
  ]);
  expect(landingPoll.head).toBe("2222222");
  expect(landingPoll.main.map((d) => d.href).slice(0, 3)).toEqual([
    null,
    null,
    null,
  ]);
  expect(landingPoll.next).toBe("T3, BLOCKED");
  expect(landingPoll.tally).toBe("2 landed · 1 queued · 1 blocked");
  expect(landingPoll.coming.map((c) => c.id)).toEqual(["T3", "T4", ""]);
  expect(landingPoll.coming[0]!.steps).toEqual([
    "done",
    "done",
    "done",
    "fail",
    "",
    "",
    "",
  ]);
  expect(landingPoll.coming[1]!.steps).toEqual(Array(7).fill(""));
  expect(
    derive(null, feed(["idle"]), NOW).coming[0]!.steps.slice(3, 6),
  ).toEqual(["done", "now", ""]);
  expect(landingPoll.queue.map((c) => c.tag).slice(0, 4)).toEqual([
    "",
    "",
    "blocked",
    "",
  ]);
  // two neighbours in the same status share one tag, or the labels overlap
  expect(
    derive(null, feed(["working", "working", "blocked"]), NOW)
      .queue.map((c) => c.tag)
      .slice(0, 3),
  ).toEqual(["working", "", "blocked"]);

  const nextPoll = derive(after, after, NOW);
  expect(nextPoll.landed).toBe(false);
  expect(nextPoll.outRow).toBe(0);
  expect(nextPoll.backRow).toBe(0);
  expect(nextPoll.builders.map((c) => c.id)).toEqual(["T3", "T4", "", ""]);
});

test("the first poll replays nothing and reports feed health", () => {
  const first = derive(null, feed(["accepted", "blocked", "working"]), NOW);
  expect(first.landed).toBe(false);
  expect(first.backRow).toBe(0);
  expect(first.state).toBe("live");
  expect(first.observed).toBe("observed 7 s ago");
  expect(first.builders[1]?.href).toBe("https://ampcode.com/threads/T-abc");

  expect(derive(null, feed([], { enabled: false }), NOW).state).toBe("paused");
  expect(
    derive(
      null,
      feed([], { target: "experiment/a-very-long-branch-name" }),
      NOW,
    ).target,
  ).toBe("experiment/a-very-long-…");
  const stale = derive(null, feed([], { fresh: false, observedAt: null }), NOW);
  expect(stale.state).toBe("stale");
  expect(stale.observed).toBe("no observation yet");
  expect(stale.next).toBe("NO TICKETS");
});

test("the queue window follows the active ticket", () => {
  const statuses: FeedTask["status"][] = Array.from({ length: 14 }, (_, i) =>
    i < 8 ? "accepted" : i === 8 ? "working" : "queued",
  );
  const view = derive(null, feed(statuses), NOW);
  expect(view.queue.map((c) => c.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `T${i + 5}`),
  );
  expect(view.main.map((d) => d.label.split(" ")[0])).toEqual(
    Array.from({ length: 7 }, (_, i) => `T${8 - i}`),
  );
});

test("an admitted ticket is the active one, ahead of the planned tickets it was picked from", () => {
  // Real feed from 2026-11-15: F021 was admitted first but listed after fifteen planned tickets.
  const view = derive(
    null,
    feed(["accepted", "planned", "planned", "working"]),
    NOW,
  );
  expect(view.tickets.map((t) => t.id)).toEqual(["T1", "T4", "T2", "T3"]);
  expect(view.next).toBe("T4, WORKING");
  expect(view.coming.map((c) => c.id)).toEqual(["T4", "T2", "T3"]);
});

test("COMING rows lay out a ticket's own steps and drop what does not fit", () => {
  const next = feed(["working", "queued", "queued"]);
  next.tasks[0]!.steps = ["first", "second"];
  next.tasks[0]!.evidence = { review: { pending: true } };
  next.tasks[1]!.steps = [
    "ab",
    "x".repeat(40),
    ...Array(9).fill("y".repeat(30)),
  ];
  const view = derive(null, next, NOW);
  const [active, first, legacy] = view.coming;

  // A pending review record puts the ticket in cold review, past the gate.
  expect(active!.steps.slice(3)).toEqual(["done", "done", "now", ""]);
  expect(view.builders[0]!.href).toBe("https://ampcode.com/threads/T-abc");

  expect(active!.chips).toEqual([]);
  expect(legacy!.chips).toEqual([]);
  expect(first!.chips[0]).toEqual({ text: "ab", x: 311, width: 31 });
  expect(first!.chips[1]!.text).toBe(`${"x".repeat(31)}…`);
  expect(first!.chips[1]!.x).toBe(311 + 31 + 20);
  expect(first!.chips.length).toBeLessThan(11);
  const last = first!.chips.at(-1)!;
  expect(last.x + last.width).toBeLessThanOrEqual(1233);
});

test("a tooltip cuts a brief-length title and leaves a short one whole", () => {
  const next = feed(["working", "idle"]);
  next.tasks[0]!.title = "x".repeat(649);
  const [long, short] = derive(null, next, NOW).builders;
  expect(long!.label).toBe(`T1 · ${"x".repeat(39)}… · working`);
  expect(short!.label).toBe("T2 · ticket 2 · idle");
  next.tasks[1]!.steps = [
    "Persist actionable stop incidents",
    "Wake the Foreman",
  ];
  expect(derive(null, next, NOW).builders[1]!.label).toBe(
    "T2 · ticket 2 · idle\nPersist actionable stop incid…",
  );
});

test("a title equal to the ticket id is not printed a second time", () => {
  const next = feed(["working", "queued"]);
  next.tasks[0]!.title = next.tasks[0]!.id;
  const view = derive(null, next, NOW);
  expect(view.builders[0]!.label).toBe("T1 · working");
  expect(view.coming[0]).toMatchObject({ id: "T1", title: "" });
  expect(view.coming[1]!.title).toBe("ticket 2");
  next.tasks[0]!.title = "T1 - post-graft review (sent)";
  const review = derive(null, next, NOW);
  expect(review.coming[0]!.title).toBe("post-graft review (sent)");
  expect(review.builders[0]!.label).toBe(
    "T1 · post-graft review (sent) · working",
  );
});

// Real sequence from backup-adoption-ticket1: "blocked" while its review is dispatched, then a
// rejection whose own "blocked" falls between two polls.
test("a pending review is never drawn blocked, and a vanished review is a rejection", () => {
  const working = feed(["accepted", "working"]);
  const dispatching = feed(["accepted", "blocked"]);
  dispatching.tasks[1]!.evidence = { review: { pending: true } };
  const view = derive(working, dispatching, NOW);
  expect(view.backRow).toBe(0);
  expect(view.builders[0]!.status).toBe("working");
  expect(view.tally).toBe("1 landed · 0 queued");
  expect(view.reviewing).toBe(true);
  expect(derive(null, dispatching, NOW).reviewing).toBe(true);
  expect(derive(dispatching, dispatching, NOW).reviewing).toBe(true);
  expect(
    derive(dispatching, { ...dispatching, fresh: false }, NOW).reviewing,
  ).toBe(false);

  const first = derive(dispatching, working, NOW);
  expect(first.backRow).toBe(1); // review gone, not landed
  expect(first.reviewing).toBe(false);
  expect(first.reviewFinished).toBe("failed");
  expect(derive(working, working, NOW).reviewFinished).toBe(null);
  expect(
    derive(dispatching, { ...working, fresh: false }, NOW).reviewFinished,
  ).toBe(null);
  dispatching.tasks[1]!.evidence = { review: { pending: true, attempt: 2 } };
  expect(derive(working, dispatching, NOW).next).toBe(
    "T2, WORKING · ATTEMPT 2",
  );
  working.tasks[1]!.attempt = 3; // repairing after a rejection: no review record
  expect(derive(dispatching, working, NOW).next).toBe(
    "T2, WORKING · ATTEMPT 3",
  );
  const second = derive(dispatching, feed(["accepted", "blocked"]), NOW);
  expect(second.backRow).toBe(1);
  expect(derive(working, working, NOW).backRow).toBe(0);
  const landed = feed(["accepted", "accepted"]);
  expect(derive(dispatching, landed, NOW).backRow).toBe(0);
  expect(derive(dispatching, landed, NOW).reviewing).toBe(false);
  expect(derive(dispatching, landed, NOW).reviewFinished).toBe("passed");
  expect(derive(landed, landed, NOW).reviewFinished).toBe(null);
});

test("the recorded replay draws a reviewed landing, rejections, a stopped reviewer and parking", () => {
  const views = FRAMES.map((_, n) =>
    derive(n ? feedAt(n - 1) : null, feedAt(n), NOW),
  );
  const polls = (hit: (view: (typeof views)[number]) => unknown) =>
    views.flatMap((view, n) => (hit(view) ? [n] : []));
  expect(polls((view) => view.landed && view.reviewed)).toEqual([6]);
  expect(polls((view) => view.backRow)).toEqual([3, 9, 13, 14]);
  expect(views[13]!.tickets.at(-1)?.stop?.href).toBe(
    "https://ampcode.com/threads/T-replay-review-2",
  );
  expect(views[14]!.tickets.at(-1)?.parked).toBe(true);
  expect(feedAt(13).tasks.at(-1)?.rejections).toEqual([
    { attempt: 1, thread: "T-replay-review-1" },
  ]);
  expect(feedAt(14).tasks.at(-1)).toMatchObject({
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
  });
  expect(views[4]!.next).toBe("BACKUP-ADOPTION-TICKET1, WORKING · ATTEMPT 6");
  expect(views[4]!.reviewing).toBe(true);
  expect(views[9]!.tally).toBe("3 landed · 0 queued · 1 blocked");
  expect(eventsAt(0).map((row) => row.action)).toEqual([
    "accepted",
    "created",
    "sent",
  ]);
  expect(eventsAt(4, 3, 2).map((row) => row.id)).toEqual([4, 5]);
  expect(eventsAt(100, 10)).toEqual([]);
});

test("the kit device gets every ticket and only notifies from recorded events", () => {
  const before = feed(["accepted", "idle", "queued", "working"]);
  const after = feed(["accepted", "accepted", "working", "blocked"]);
  const view = derive(before, after, NOW);
  expect(view.counts).toEqual({ landed: 2, queued: 0, blocked: 1 });
  expect(view.tickets.map((ticket) => ticket.stage)).toEqual([7, 7, 3, 3]);
  expect(view.tickets[1]).toMatchObject({
    id: "T2",
    title: "ticket 2",
    revision: "2222222",
    review: "none",
    steps: Array(7).fill("done"),
  });
  expect(view.news).toEqual([]);
  expect(view.main[0]!.id).toBe("T2");
  expect(
    derive(after, after, NOW, [
      {
        id: 5,
        at: "2026-11-13T12:00:03Z",
        ticket: "T2",
        action: "accepted",
        attempt: 2,
      },
      { id: 6, at: "2026-11-13T12:00:04Z", ticket: "T4", action: "rejected" },
    ]).news,
  ).toEqual([
    {
      at: "2026-11-13T12:00:03Z",
      tone: "success",
      title: "T2 accepted",
      text: "2026-11-13T12:00:03Z · attempt 2",
    },
    {
      at: "2026-11-13T12:00:04Z",
      tone: "danger",
      title: "T4 rejected",
      text: "2026-11-13T12:00:04Z",
    },
  ]);
});

test("notices wait for catch-up across full pages and a failed first request", () => {
  const history = Array.from({ length: 502 }, (_, i) => ({
    id: i + 1,
    at: "2000-01-01T00:00:00Z",
    ticket: "T1",
    action: "sent",
  }));
  const scenarios = [
    [history.slice(0, 500), history.slice(500)],
    [null, history.slice(0, 3)],
    [history.slice(0, 500), null, []],
  ];
  for (const pages of scenarios) {
    let caughtUp = false;
    for (const page of pages) {
      const batch = eventBatch(caughtUp, page, 500);
      caughtUp = batch.caughtUp;
      expect(derive(null, feed([]), NOW, batch.news).news).toEqual([]);
    }
    const live = eventBatch(
      caughtUp,
      [
        {
          id: 503,
          at: "2026-11-13T12:00:03Z",
          ticket: "T1",
          action: "accepted",
        },
      ],
      500,
    );
    expect(derive(null, feed([]), NOW, live.news).news).toEqual([
      {
        at: "2026-11-13T12:00:03Z",
        tone: "success",
        title: "T1 accepted",
        text: "2026-11-13T12:00:03Z",
      },
    ]);
    expect(eventBatch(live.caughtUp, null, 500)).toEqual({
      caughtUp: true,
      news: [],
    });
  }
});

test("event rows keep cursor order, exact ticket filters and safe thread links", () => {
  const events = [
    {
      id: 1,
      at: "2026-11-13T12:00:03Z",
      ticket: "A",
      action: "sent",
      thread: "T-worker",
    },
    {
      id: 2,
      at: "2026-11-13T12:00:04Z",
      ticket: "AB",
      action: "future-action",
    },
    {
      id: 3,
      at: "2026-11-13T12:00:05Z",
      ticket: "A",
      action: "review-sent",
      thread: "T-unsafe\n",
    },
  ];
  expect(eventRows(events).map((row) => row.id)).toEqual([1, 2, 3]);
  expect(eventRows(events, "A").map(({ id, href }) => ({ id, href }))).toEqual([
    { id: 1, href: "https://ampcode.com/threads/T-worker" },
    { id: 3, href: null },
  ]);
  expect(eventRows(events, "missing")).toEqual([]);
  expect(eventRows(events, "AB")[0]?.href).toBeNull();
});
