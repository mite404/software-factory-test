import { expect, test } from "bun:test";
import { derive, type Feed, type Task } from "./derive";
import { feedAt, FRAMES } from "./replay";

const NOW = Date.parse("2026-11-13T12:00:10Z");

function feed(statuses: Task["status"][], extra: Partial<Feed> = {}): Feed {
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
  const statuses: Task["status"][] = Array.from({ length: 14 }, (_, i) =>
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

test("the recorded replay draws one reviewed landing, one rejection and one block", () => {
  const views = FRAMES.map((_, n) =>
    derive(n ? feedAt(n - 1) : null, feedAt(n), NOW),
  );
  const polls = (hit: (view: (typeof views)[number]) => unknown) =>
    views.flatMap((view, n) => (hit(view) ? [n] : []));
  expect(polls((view) => view.landed && view.reviewed)).toEqual([6]);
  expect(polls((view) => view.backRow)).toEqual([3, 9]); // review vanished, then a plain block
  expect(views[4]!.next).toBe("BACKUP-ADOPTION-TICKET1, WORKING · ATTEMPT 6");
  expect(views[4]!.reviewing).toBe(true);
  expect(views[9]!.tally).toBe("3 landed · 0 queued · 1 blocked");
});
