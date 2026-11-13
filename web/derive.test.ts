import { expect, test } from "bun:test";
import { derive, type Feed, type Task } from "./derive";

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

test("only a queued ticket that starts work gets a foreman hand-off", () => {
  const view = derive(
    feed(["idle", "queued"]),
    feed(["working", "working"]),
    NOW,
  );
  expect(view.startRow).toBe(2);
  expect(derive(null, feed(["working"]), NOW).startRow).toBe(0);
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

  // ACTIVE keeps the stage pills; its steps go on the header line instead.
  expect(view.activeSteps).toBe("first → second");
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
