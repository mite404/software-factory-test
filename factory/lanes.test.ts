import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration, createFactory, type NativeHost } from "./native";
import { openStore } from "./bookkeeping.fixture";
import { factoryEvents, openPersistence, type Run } from "./persistence";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const light = { model: "anthropic/claude-sonnet-5-5", effort: "high" };

type Ticket = { id: string; lane?: "light"; after?: string[] };

async function fixture(
  tickets: Ticket[],
  definition: Record<string, unknown> = { capacity: 2, lightWorker: light },
) {
  const root = await mkdtemp(join(tmpdir(), "factory-lanes-"));
  git(root, "init", "-q");
  // CI runners have no global Git identity; every fixture commit uses this one.
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/shared"), "one\ntwo\nthree\n");
  await writeFile(join(root, "prd.md"), "Requirements");
  await writeFile(
    join(root, "tickets.json"),
    JSON.stringify(
      tickets.map((ticket) => ({
        brief: `Work ${ticket.id}`,
        after: [],
        ...ticket,
      })),
    ),
  );
  await writeFile(
    join(root, ".factory.json"),
    JSON.stringify({
      version: 1,
      capacity: 1,
      workerModel: "openai/gpt-6.1-sol",
      workerEffort: "medium",
      prd: "prd.md",
      tickets: "tickets.json",
      scope: ["src/"],
      // Each gate records the exact revision it checked.
      verify: `git rev-parse HEAD >> '${join(root, ".git/gates")}' && ! grep -q bad src/*`,
      permissions: { execute: true, publish: false, externalTickets: false },
      ...definition,
    }),
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  const created: Parameters<NativeHost["create"]>[] = [];
  const messages: { thread: string; message: string }[] = [];
  const activity = new Map<string, Awaited<ReturnType<NativeHost["state"]>>>();
  const host: NativeHost = {
    async create(...args) {
      created.push(args);
      return `T-${created.length}`;
    },
    async send(thread, message) {
      messages.push({ thread, message });
    },
    async state(thread) {
      return activity.get(thread) ?? "idle";
    },
    watch() {},
  };
  let factory = createFactory(root, host, openStore);
  const directory = factory.directory;
  const tick = () => factory.tick("reconcile", "T-owner");
  const worktree = (id: string) => join(directory, "worktrees", id);
  return {
    root,
    directory,
    created,
    messages,
    activity,
    get factory() {
      return factory;
    },
    /** A fresh coordinator over the same saved state, as after a crash. */
    reopen() {
      factory = createFactory(root, host, openStore);
    },
    tick,
    start: () => factory.tick("start", "T-owner"),
    /** Commit one file change in a worker worktree and report it as a candidate. */
    async submit(id: string, file: string, content: string, attempt = 1) {
      await writeFile(join(worktree(id), "src", file), content);
      git(worktree(id), "add", ".");
      git(worktree(id), "commit", "-qm", `candidate ${id}`);
      const revision = git(worktree(id), "rev-parse", "HEAD");
      await writeFile(
        join(directory, `${id}.report.json`),
        JSON.stringify({ attempt, kind: "candidate", revision, insight: id }),
      );
      return revision;
    },
    async gates() {
      return (await readFile(join(root, ".git/gates"), "utf8"))
        .trim()
        .split("\n");
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("capacity one without a light lane dispatches one ticket and leaves the next waiting", async () => {
  const f = await fixture([{ id: "A" }, { id: "B" }], {});
  try {
    const state = await f.start();
    expect(Object.keys(state.runs)).toEqual(["A"]);
    expect(state.runs.A).toMatchObject({ kind: "running", thread: "T-1" });
    expect(state.runs.A).not.toHaveProperty("lane");
    await f.tick();
    expect(f.created.map(([, model, effort]) => [model, effort])).toEqual([
      ["openai/gpt-6.1-sol", "medium"],
    ]);
    await f.submit("A", "a", "a\n");
    const done = await f.tick();
    expect(done.runs.A?.kind).toBe("done");
    expect(done.runs.B).toMatchObject({ kind: "running", thread: "T-2" });
  } finally {
    await f.close();
  }
});

test("two lanes start a main and a light worker on their own models, one run per lane", async () => {
  const f = await fixture([
    { id: "L1", lane: "light" },
    { id: "L2", lane: "light" },
    { id: "M1" },
    { id: "M2" },
  ]);
  try {
    const state = await f.start();
    expect(state.runs.L1).toMatchObject({
      kind: "running",
      lane: "light",
      workerModel: "anthropic/claude-sonnet-5-5",
    });
    expect(state.runs.M1).toMatchObject({
      kind: "running",
      workerModel: "openai/gpt-6.1-sol",
    });
    expect(state.runs.M1).not.toHaveProperty("lane");
    expect(state.runs.L2).toBeUndefined();
    expect(state.runs.M2).toBeUndefined();
    expect(f.created.map(([, model, effort]) => [model, effort])).toEqual([
      ["anthropic/claude-sonnet-5-5", "high"],
      ["openai/gpt-6.1-sol", "medium"],
    ]);
    const database = join(f.directory, "state.sqlite");
    const before = await readFile(database);
    const events = factoryEvents(f.directory);
    await f.tick();
    expect(await readFile(database)).toEqual(before);
    expect(factoryEvents(f.directory)).toEqual(events);
    expect(f.created).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("an escalated light run holds only the light lane while main keeps dispatching", async () => {
  const f = await fixture([
    { id: "L1", lane: "light" },
    { id: "L2", lane: "light" },
    { id: "M1" },
    { id: "M2" },
  ]);
  try {
    await f.start();
    await f.submit("L1", "light", "bad\n");
    expect((await f.tick()).runs.L1).toMatchObject({
      kind: "running",
      attempt: 2,
      thread: "T-1",
    });
    await f.submit("L1", "light", "bad again\n", 2);
    await f.submit("M1", "main", "main\n");
    const state = await f.tick();
    expect(state.runs.L1).toMatchObject({
      kind: "blocked",
      lane: "light",
      repair: { attempt: 2 },
      incident: { reason: "verification-rejected" },
    });
    await f.tick();
    const next = await f.tick();
    expect(next.runs.M1?.kind).toBe("done");
    expect(next.runs.M2).toMatchObject({ kind: "running", thread: "T-3" });
    expect(next.runs.L2).toBeUndefined();
  } finally {
    await f.close();
  }
});

test.each(["awaiting-approval", "error", "blocked-report"] as const)(
  "a light worker stopped by %s keeps the light lane while main work starts and settles",
  async (stop) => {
    const f = await fixture([
      { id: "L1", lane: "light" },
      { id: "L2", lane: "light" },
      { id: "M1" },
      { id: "M2" },
    ]);
    try {
      const started = await f.start();
      expect(started.runs.L1).toMatchObject({ kind: "running", thread: "T-1" });
      if (stop === "blocked-report")
        await writeFile(
          join(f.directory, "L1.report.json"),
          JSON.stringify({ attempt: 1, kind: "blocked", reason: "Need input" }),
        );
      else f.activity.set("T-1", stop);
      const stopped = await f.tick();
      expect(stopped.runs.L1).toMatchObject({
        kind: "blocked",
        lane: "light",
        checkpoint: { thread: "T-1" },
      });
      expect(stopped.runs.L2).toBeUndefined();
      await f.submit("M1", "main", "main\n");
      const next = await f.tick();
      expect(next.runs.M1?.kind).toBe("done");
      expect(next.runs.M2).toMatchObject({ kind: "running", thread: "T-3" });
      expect(next.runs.L2).toBeUndefined();
      expect(f.created).toHaveLength(3);
    } finally {
      await f.close();
    }
  },
);

test("a repaired candidate after a rejected rebase is rebased again and lands", async () => {
  // The candidate passes on its own base and fails only once rebased beside main's file.
  const f = await fixture(
    [{ id: "M1" }, { id: "L1", lane: "light" }, { id: "M2" }],
    {
      capacity: 2,
      lightWorker: light,
      verify:
        'git rev-parse HEAD >> "$(git rev-parse --git-common-dir)/gates" && ! { test -f src/main && grep -q needs-main-free src/light; }',
    },
  );
  try {
    await f.start();
    await f.submit("M1", "main", "main\n");
    await f.tick();
    const first = git(f.root, "rev-parse", "HEAD");
    await f.submit("L1", "light", "needs-main-free\n");
    const rejected = (await f.tick()).runs.L1;
    expect(rejected).toMatchObject({
      kind: "running",
      attempt: 2,
      base: first,
    });
    expect(f.messages.at(-1)!.message).toContain(
      "Verification rejected attempt 1",
    );
    await f.submit("M2", "main2", "main2\n");
    expect((await f.tick()).runs.M2?.kind).toBe("done");
    const second = git(f.root, "rev-parse", "HEAD");
    const repaired = await f.submit("L1", "light", "good\n", 2);
    const done = (await f.tick()).runs.L1;
    if (done?.kind !== "done") throw new Error("Expected landed repair");
    expect(done.revision).not.toBe(repaired);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(done.revision);
    // The repair sits on the rejected rebased commit, so both replay onto the new target.
    expect(git(f.root, "rev-parse", "HEAD~2")).toBe(second);
    expect((await f.gates()).at(-1)).toBe(done.revision);
    expect(await readFile(join(f.root, "src/light"), "utf8")).toBe("good\n");
    expect(f.created).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test.each(["light", "main"] as const)(
  "resuming a parked light run beside a %s-lane run blocked on approval",
  async (blockerLane) => {
    const f = await fixture([{ id: "L1", lane: "light" }, { id: "B1" }]);
    try {
      const base = git(f.root, "rev-parse", "HEAD");
      const worktree = join(f.directory, "worktrees/L1");
      git(f.root, "worktree", "add", "-q", "-b", "feat/L1", worktree, base);
      const checkpoint = (thread: `T-${string}`, attempt: number) => ({
        kind: "running" as const,
        thread,
        worktree,
        base,
        attempt,
        delivery: "sent" as const,
      });
      const runs: Record<string, Run> = {
        L1: {
          kind: "parked",
          lane: "light",
          thread: "T-L1",
          reason: "Verification rejected attempt 4",
          repair: checkpoint("T-L1", 4),
          incident: {
            id: "parked-L1",
            ticket: "L1",
            owner: "T-owner",
            base,
            attempt: 4,
            reason: "verification-rejected",
            recovery: "resume",
            delivery: "sent",
          },
        },
        B1: {
          kind: "blocked",
          ...(blockerLane === "light" ? { lane: "light" as const } : {}),
          thread: "T-B1",
          reason: "Worker awaiting-approval; inspect before resuming",
          checkpoint: { ...checkpoint("T-B1", 1), worktree: `${worktree}-B1` },
          incident: {
            id: "approval-B1",
            ticket: "B1",
            owner: "T-owner",
            base,
            attempt: 1,
            reason: "approval-required",
            recovery: "resume",
            delivery: "sent",
          },
        },
      };
      const storage = openPersistence(f.directory, []);
      storage.commit(
        { enabled: false, owner: "T-owner", runs },
        "L1",
        "fixture",
        "parked beside an approval stop",
      );
      storage.close();
      const saved = (await f.factory.tick("status")).runs;
      const resume = f.factory.tick("resume", "T-owner", async () => "idle", {
        ticket: "L1",
        incident: "parked-L1",
        decision: "Operator approved one more repair",
      });
      if (blockerLane === "light") {
        expect(await resume.catch(String)).toContain(
          "Resolve active or uncertain work",
        );
        expect((await f.factory.tick("status")).runs).toEqual(saved);
      } else
        expect((await resume).runs.L1).toMatchObject({
          kind: "running",
          thread: "T-L1",
          attempt: 5,
          lane: "light",
        });
      expect(f.messages).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("a rebase interrupted before the worker reset finishes on reopen with one gate and review", async () => {
  const f = await fixture([{ id: "A" }], { review: true });
  try {
    await f.start();
    const reported = await f.submit("A", "a", "a\n");
    await writeFile(join(f.root, "prd.md"), "Foreman edit");
    git(f.root, "commit", "-qam", "Foreman commit before review");
    const target = git(f.root, "rev-parse", "HEAD");
    const worktree = join(f.directory, "worktrees/A");
    const lock = join(
      git(worktree, "rev-parse", "--absolute-git-dir"),
      "index.lock",
    );
    // A held index lock makes the worker reset fail right after the durable rebase intent.
    await writeFile(lock, "");
    expect(await f.tick().catch(String)).toContain("index.lock");
    const interrupted = (await f.factory.tick("status")).runs.A;
    if (interrupted?.kind !== "running" || !interrupted.rebased)
      throw new Error("Expected a saved rebase intent");
    expect(interrupted).toMatchObject({
      base: target,
      rebased: { from: reported, source: reported, at: "intended" },
    });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(reported);
    const rebased = interrupted.rebased.revision;
    await rm(lock);
    f.reopen();
    const resumed = (await f.tick()).runs.A;
    expect(resumed).toMatchObject({
      kind: "running",
      attempt: 1,
      rebased: { revision: rebased, at: "verified" },
      review: { revision: rebased, base: target, thread: "T-2" },
    });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(rebased);
    expect((await f.gates()).filter((gate) => gate === rebased)).toHaveLength(
      1,
    );
    const database = join(f.directory, "state.sqlite");
    const before = await readFile(database);
    await f.tick();
    expect(await readFile(database)).toEqual(before);
    const actions = (factoryEvents(f.directory) ?? []).map(
      (event) => event.action,
    );
    expect(
      actions.filter((action) => action === "rebase-intended"),
    ).toHaveLength(1);
    expect(actions.filter((action) => action === "rebased")).toHaveLength(1);
    expect(f.created).toHaveLength(2);
    await writeFile(
      resumed!.kind === "running" ? resumed.review!.report : "",
      JSON.stringify({
        ticket: "A",
        attempt: 1,
        revision: rebased,
        base: target,
        stage: "post-graft",
        kind: "pass",
        findings: [],
      }),
    );
    expect((await f.tick()).runs.A).toMatchObject({
      kind: "done",
      revision: rebased,
    });
    expect(git(f.root, "rev-parse", "HEAD")).toBe(rebased);
  } finally {
    await f.close();
  }
});

test("a light setup retry is refused, unchanged, once the definition drops lightWorker", async () => {
  const f = await fixture([{ id: "L1", lane: "light" }], {
    capacity: 2,
    lightWorker: light,
    setup: 'test -f "$(git rev-parse --git-common-dir)/setup-ok"',
  });
  try {
    const failed = (await f.start()).runs.L1;
    expect(failed).toMatchObject({ kind: "preparation-failed", lane: "light" });
    const config = join(f.root, ".factory.json");
    const tickets = join(f.root, "tickets.json");
    const twoLanes = await readFile(config, "utf8");
    const lightQueue = await readFile(tickets, "utf8");
    const { lightWorker: _, ...oneLane } = JSON.parse(twoLanes);
    await writeFile(config, JSON.stringify({ ...oneLane, capacity: 1 }));
    await writeFile(
      tickets,
      JSON.stringify([{ id: "L1", brief: "Work L1", after: [] }]),
    );
    git(f.root, "commit", "-qam", "drop the light lane");
    await writeFile(join(f.root, ".git/setup-ok"), "");
    const retry = () => f.factory.tick("retry-setup", "T-owner");
    expect(await retry().catch(String)).toContain(
      "needs a definition with lightWorker",
    );
    expect((await f.factory.tick("status")).runs.L1).toEqual(failed);
    expect(f.created).toEqual([]);
    await writeFile(config, twoLanes);
    await writeFile(tickets, lightQueue);
    git(f.root, "commit", "-qam", "restore the light lane");
    expect((await retry()).runs.L1).toMatchObject({
      kind: "running",
      lane: "light",
      workerModel: "anthropic/claude-sonnet-5-5",
    });
    expect(f.created.map(([, model, effort]) => [model, effort])).toEqual([
      ["anthropic/claude-sonnet-5-5", "high"],
    ]);
  } finally {
    await f.close();
  }
});

test("a factory-wide brief refusal holds both lanes", async () => {
  const f = await fixture([
    { id: "M1" },
    { id: "L1", lane: "light" },
    { id: "M2", after: ["M1"] },
    { id: "L2", lane: "light" },
  ]);
  try {
    await f.start();
    f.activity.set("T-2", "running");
    const report = join(f.directory, "M1.report.json");
    await f.submit("M1", "main", "main\n");
    const empty = {
      ...JSON.parse(await readFile(report, "utf8")),
      insight: " ",
    };
    await writeFile(report, JSON.stringify(empty));
    expect((await f.tick()).runs.M2).toMatchObject({
      kind: "blocked",
      incident: { reason: "brief-incomplete" },
    });
    f.activity.set("T-2", "idle");
    await f.submit("L1", "light", "light\n");
    const state = await f.tick();
    expect(state.runs.L1?.kind).toBe("done");
    expect(state.runs.L2).toBeUndefined();
    expect(f.created).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("a light candidate behind a landed main candidate is rebased, gated and landed at its new revision", async () => {
  const f = await fixture([{ id: "M1" }, { id: "L1", lane: "light" }]);
  try {
    await f.start();
    await f.submit("M1", "shared", "one\ntwo\nthree\nmain\n");
    const main = (await f.tick()).runs.M1!;
    expect(main.kind).toBe("done");
    const target = git(f.root, "rev-parse", "HEAD");
    const reported = await f.submit("L1", "shared", "light\none\ntwo\nthree\n");
    const state = await f.tick();
    const done = state.runs.L1;
    if (done?.kind !== "done") throw new Error("Expected landed light run");
    expect(done.revision).not.toBe(reported);
    expect(done).toMatchObject({ acceptedBase: target, lane: "light" });
    expect(git(f.root, "rev-parse", "HEAD")).toBe(done.revision);
    expect(git(f.root, "rev-parse", "HEAD^")).toBe(target);
    expect(await readFile(join(f.root, "src/shared"), "utf8")).toBe(
      "light\none\ntwo\nthree\nmain\n",
    );
    expect((await f.gates()).at(-1)).toBe(done.revision);
    expect(f.created).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("a rebased candidate is reviewed at the rebased revision by its saved worker's reviewer", async () => {
  const f = await fixture([{ id: "M1" }, { id: "L1", lane: "light" }], {
    capacity: 2,
    lightWorker: light,
    review: true,
  });
  try {
    await f.start();
    await f.submit("M1", "main", "main\n");
    await f.tick();
    const review = (await f.factory.tick("status")).runs.M1;
    if (review?.kind !== "running" || !review.review)
      throw new Error("Expected main review");
    await writeFile(
      review.review.report,
      JSON.stringify({
        ticket: "M1",
        attempt: 1,
        revision: review.review.revision,
        base: review.review.base,
        stage: "post-graft",
        kind: "pass",
        findings: [],
      }),
    );
    const reported = await f.submit("L1", "light", "light\n");
    await f.tick();
    const target = git(f.root, "rev-parse", "HEAD");
    expect(target).toBe(review.review.revision);
    await f.tick();
    const rebased = (await f.factory.tick("status")).runs.L1;
    if (rebased?.kind !== "running" || !rebased.review)
      throw new Error("Expected light review");
    expect(rebased.review.revision).not.toBe(reported);
    expect(rebased).toMatchObject({
      workerModel: "anthropic/claude-sonnet-5-5",
      base: target,
      review: { base: target, model: "openai/gpt-6-astra" },
    });
    expect(git(f.root, "rev-parse", `${rebased.review.revision}^`)).toBe(
      target,
    );
    expect((await f.gates()).at(-1)).toBe(rebased.review.revision);
    expect(review.review.model).toBe("anthropic/claude-fable-5-2");
  } finally {
    await f.close();
  }
});

test("a conflicting rebase returns to the same worker thread as repair feedback without landing", async () => {
  const f = await fixture([{ id: "M1" }, { id: "L1", lane: "light" }]);
  try {
    const worker = (await f.start()).runs.L1;
    if (worker?.kind !== "running") throw new Error("Expected light worker");
    await f.submit("M1", "shared", "one\nmain\nthree\n");
    await f.tick();
    const target = git(f.root, "rev-parse", "HEAD");
    const reported = await f.submit("L1", "shared", "one\nlight\nthree\n");
    const state = await f.tick();
    expect(state.runs.L1).toMatchObject({
      kind: "running",
      thread: worker.thread,
      attempt: 2,
      base: target,
      delivery: "sent",
    });
    expect(git(f.root, "rev-parse", "HEAD")).toBe(target);
    expect(git(join(f.directory, "worktrees/L1"), "rev-parse", "HEAD")).toBe(
      reported,
    );
    const feedback = f.messages.at(-1)!;
    expect(feedback.thread).toBe(worker.thread);
    expect(feedback.message).toContain("conflicted");
    expect(feedback.message).toContain(`Rebase onto ${target}`);
    expect(f.created).toHaveLength(2);
  } finally {
    await f.close();
  }
});

// The reviewer writes its verdict, then a Foreman commit moves the target (F011 attempt 2).
async function verdictThenMove(kind: "issues" | "pass") {
  const f = await fixture([{ id: "A" }], { review: true });
  const reported = await f.start().then(() => f.submit("A", "a", "a\n"));
  await f.tick();
  const running = (await f.factory.tick("status")).runs.A;
  if (running?.kind !== "running" || !running.review)
    throw new Error("Expected review");
  const finding = {
    severity: "critical",
    location: "src/a:1",
    evidence: "CANARY-FINDING",
    correction: "Repair a",
  };
  await writeFile(
    running.review.report,
    JSON.stringify({
      ticket: "A",
      attempt: 1,
      revision: running.review.revision,
      base: running.review.base,
      stage: "post-graft",
      kind,
      findings: kind === "issues" ? [finding] : [],
    }),
  );
  await writeFile(join(f.root, "prd.md"), "Foreman edit");
  git(f.root, "commit", "-qam", "Foreman commit during review");
  const target = git(f.root, "rev-parse", "HEAD");
  const run = (await f.tick()).runs.A;
  if (run?.kind !== "running") throw new Error("Expected running");
  expect(run.thread).toBe("T-1");
  expect(run.incident).toBeUndefined();
  expect(git(f.root, "rev-parse", "HEAD")).toBe(target);
  expect(
    factoryEvents(f.directory)?.filter(
      (event) => event.action === "review-verdict",
    ),
  ).toHaveLength(1);
  return { f, run, reported, target };
}

test("an issues verdict written before the target moved returns to the worker as repair feedback", async () => {
  const { f, run } = await verdictThenMove("issues");
  try {
    expect(run.attempt).toBe(2);
    expect(f.created).toHaveLength(2);
    const feedback = f.messages.at(-1)!;
    expect(feedback.thread).toBe("T-1");
    expect(feedback.message).toContain("CANARY-FINDING");
  } finally {
    await f.close();
  }
});

test("a pass verdict written before the target moved leads to a rebase, gate and fresh review", async () => {
  const { f, run, reported, target } = await verdictThenMove("pass");
  try {
    expect(run).toMatchObject({
      attempt: 1,
      base: target,
      review: { base: target, thread: "T-3" },
    });
    const revision = run.review!.revision;
    expect(revision).not.toBe(reported);
    expect(git(f.root, "rev-parse", `${revision}^`)).toBe(target);
    expect((await f.gates()).at(-1)).toBe(revision);
    expect(f.created).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test.each([
  [{ capacity: 2 }, /capacity 2 requires lightWorker/],
  [{ capacity: 1, lightWorker: light }, /capacity 2 requires lightWorker/],
  [
    { capacity: 2, lightWorker: { model: "unknown/model", effort: "high" } },
    /Invalid lightWorker/,
  ],
  [
    { capacity: 2, lightWorker: { ...light, effort: "turbo" } },
    /Invalid lightWorker/,
  ],
  [{ capacity: 3, lightWorker: light }, /capacity 1 or 2/],
])("definition %j fails parsing", async (definition, error) => {
  const f = await fixture([{ id: "A" }]);
  try {
    const path = join(f.root, ".factory.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    delete raw.lightWorker;
    await writeFile(path, JSON.stringify({ ...raw, ...definition }));
    expect(configuration(f.root)).rejects.toThrow(error);
  } finally {
    await f.close();
  }
});

test("a light queue entry without a light lane fails parsing", async () => {
  const f = await fixture([{ id: "A", lane: "light" }]);
  try {
    expect(await configuration(f.root)).toMatchObject({ lightWorker: light });
    const path = join(f.root, ".factory.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    delete raw.lightWorker;
    await writeFile(path, JSON.stringify({ ...raw, capacity: 1 }));
    expect(configuration(f.root)).rejects.toThrow(/Invalid ticket lane/);
  } finally {
    await f.close();
  }
});
