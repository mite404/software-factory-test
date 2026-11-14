import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactory, tasks, type NativeHost } from "./native";
import { openStore } from "./bookkeeping.fixture";
import type { Task } from "./persistence";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const finding = {
  severity: "critical",
  location: "src/value:1",
  evidence: "Value violates requirements",
  correction: "Repair value",
};

async function fixture(
  scope: Partial<Task> = {},
  workerModel = "openai/gpt-6.1-sol",
  failure = "",
) {
  const root = await mkdtemp(join(tmpdir(), "factory-review-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value"), "old");
  await writeFile(join(root, "prd.md"), "Original requirements");
  await writeFile(
    join(root, "tickets.json"),
    JSON.stringify([
      {
        id: "A",
        brief:
          "Repair value. Blast radius: shared consumers; prove no acceptance without required proof.",
        after: [],
        ...scope,
      },
      { id: "B", brief: "Dependent", after: ["A"] },
    ]),
  );
  await writeFile(
    join(root, ".factory.json"),
    JSON.stringify({
      version: 1,
      capacity: 1,
      review: true,
      workerModel,
      prd: "prd.md",
      tickets: "tickets.json",
      scope: ["src/"],
      verify:
        `printf gate >> '${join(root, ".git/gates")}'` +
        (failure === "gate" ? '; test "$(cat src/value)" != "value 1"' : ""),
      permissions: { execute: true, publish: false, externalTickets: false },
    }),
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  const settings: Parameters<NativeHost["create"]>[] = [];
  const messages: { thread: string; message: string }[] = [];
  const watched: string[] = [];
  let activity: Awaited<ReturnType<NativeHost["state"]>> = "idle";
  const host: NativeHost = {
    async create(...args) {
      settings.push(args);
      if (args[3] === "reviewer" && failure === "create")
        throw new Error("Creation unknown");
      return `T-${settings.length}`;
    },
    async send(thread, message) {
      messages.push({ thread, message });
      if (thread !== "T-1" && failure === "send")
        throw new Error("Delivery unknown");
    },
    async state() {
      return activity;
    },
    watch(thread) {
      watched.push(thread);
    },
  };
  let factory = createFactory(root, host, openStore);
  const initial = (await factory.tick("start", "T-owner")).runs.A;
  if (initial?.kind !== "running") throw new Error("No worker");
  const worktree = initial.worktree;
  const tick = () => factory.tick("reconcile");
  const status = () => factory.tick("status");
  const review = async () => {
    const run = (await status()).runs.A;
    if (run?.kind !== "running" || !run.review) throw new Error("No review");
    return run.review;
  };
  const verdict = async (
    kind = "pass",
    patch: Record<string, unknown> = {},
  ) => {
    const row = await review();
    const value = {
      ticket: "A",
      attempt: row.attempt,
      revision: row.revision,
      base: row.base,
      stage: "post-graft",
      kind,
      findings: kind === "issues" ? [finding] : [],
      ...patch,
    };
    await writeFile(row.report, JSON.stringify(value));
  };
  const submit = async (attempt: number) => {
    await writeFile(join(worktree, "src/value"), `value ${attempt}`);
    git(worktree, "add", ".");
    git(worktree, "commit", "-qm", "candidate");
    await writeFile(
      join(factory.directory, "A.report.json"),
      JSON.stringify({
        kind: "candidate",
        attempt,
        revision: git(worktree, "rev-parse", "HEAD"),
        insight: "CANARY-WORKER-RATIONALE",
      }),
    );
  };
  return {
    root,
    worktree,
    settings,
    messages,
    watched,
    tick,
    status,
    review,
    verdict,
    submit,
    resume() {
      return factory.tick("resume", "T-owner", host.state, {
        ticket: "A",
        decision:
          "Use the review reproduction to repair the shared value contract",
      });
    },
    observe(value: typeof activity) {
      activity = value;
    },
    reload() {
      factory = createFactory(root, host, openStore);
    },
    loadDefinition() {
      return factory.tick("reload", "T-owner");
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("review requirements keep the dispatched brief across queue edits and reload", async () => {
  const f = await fixture();
  try {
    const configPath = join(f.root, ".factory.json");
    const queuePath = join(f.root, "tickets.json");
    const originalConfig = await readFile(configPath, "utf8");
    const originalQueue = await readFile(queuePath, "utf8");
    const originalInstructions = await readFile(join(f.root, "prd.md"), "utf8");
    const queue = JSON.parse(originalQueue);
    const brief = queue[0].brief;
    queue[0].brief = "Changed live brief";
    await writeFile(queuePath, JSON.stringify(queue));
    await writeFile(join(f.root, ".git/info/exclude"), "future-tickets.json\n");
    queue[0].brief = "Changed reload brief";
    await writeFile(join(f.root, "future-tickets.json"), JSON.stringify(queue));
    await writeFile(
      configPath,
      JSON.stringify({
        ...JSON.parse(originalConfig),
        tickets: "future-tickets.json",
      }),
    );
    await writeFile(join(f.root, "prd.md"), "Changed reload instructions");
    await f.loadDefinition();
    await writeFile(configPath, originalConfig);
    await writeFile(queuePath, originalQueue);
    await writeFile(join(f.root, "prd.md"), originalInstructions);
    f.reload();
    for (const attempt of [1, 2]) {
      await f.submit(attempt);
      await f.tick();
      const message = f.messages.at(-1)!.message;
      expect(message).toContain(brief);
      expect(message).toContain(originalInstructions);
      expect(message).not.toContain("Changed live brief");
      expect(message).not.toContain("Changed reload brief");
      expect(message).not.toContain("Changed reload instructions");
      if (attempt === 1) {
        await f.verdict("issues");
        await f.tick();
      }
    }
  } finally {
    await f.close();
  }
});

test.each([
  ["openai/gpt-6.1-sol", "anthropic/claude-fable-5-2"],
  ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"],
] as const)(
  "cold post-graft review returns issues to %s owner",
  async (worker, reviewer) => {
    const f = await fixture({}, worker);
    try {
      await f.submit(1);
      const waiting = await f.tick();
      expect(waiting.runs.A?.kind).toBe("running");
      expect(waiting.runs.B).toBeUndefined();
      expect(await readFile(join(f.root, "src/value"), "utf8")).toBe("old");
      expect(f.settings[1]).toEqual(["T-owner", reviewer, "high", "reviewer"]);
      const review = await f.review();
      expect(review.stage).toBe("post-graft");
      expect(review.worktree).not.toBe(f.worktree);
      expect(git(review.worktree, "rev-parse", "HEAD")).toBe(
        git(f.worktree, "rev-parse", "HEAD"),
      );
      expect(f.messages[1]?.message).not.toContain("CANARY");
      await f.verdict("issues");
      expect((await f.tick()).runs.A).toMatchObject({
        kind: "running",
        thread: "T-1",
        attempt: 2,
      });
      expect(f.messages.at(-1)?.thread).toBe("T-1");
      expect(f.messages.at(-1)?.message).toContain("src/value:1");
      await f.submit(2);
      await f.tick();
      expect(f.settings).toHaveLength(3);
      expect(f.messages.at(-1)?.message).not.toContain("CANARY");
      expect(f.messages.at(-1)?.message).not.toContain("violates requirements");
      await f.verdict();
      expect((await f.tick()).runs.A?.kind).toBe("done");
      expect((await f.status()).runs.B?.kind).toBe("running");
      expect(await readFile(join(f.root, ".git/gates"), "utf8")).toBe(
        "gategate",
      );
      f.reload();
      await Promise.all([f.tick(), f.tick()]);
      expect(f.settings).toHaveLength(4);
      const db = new Database(join(f.root, ".git/factory/state.sqlite"), {
        readonly: true,
      });
      try {
        expect(
          db
            .query(
              "SELECT detail FROM events WHERE ticket='A' AND action='accepted'",
            )
            .all(),
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);

test.each([
  { size: "small", risky: false },
  { size: "small" },
  { size: "small", risky: true },
  { size: "medium", risky: false },
  { size: "large", risky: false },
  {},
] satisfies Partial<Task>[])(
  "scope and blast radius policy: %j",
  async (scope) => {
    const f = await fixture(scope);
    try {
      await f.submit(1);
      const state = await f.tick();
      const skip = scope.size === "small" && !scope.risky;
      expect(state.runs.A?.kind).toBe(skip ? "done" : "running");
      expect(f.settings.filter((args) => args[3] === "reviewer")).toHaveLength(
        skip ? 0 : 1,
      );
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  "review escalation resumes the same owner beyond two attempts (legacy %s)",
  async (legacy) => {
    const f = await fixture({ size: "small" }, undefined, "gate");
    try {
      await f.submit(1);
      expect((await f.tick()).runs.A).toMatchObject({
        kind: "running",
        attempt: 2,
      });
      expect(f.settings).toHaveLength(1);
      await f.submit(2);
      await f.tick();
      expect(f.settings).toHaveLength(2);
      await f.verdict("issues");
      expect((await f.tick()).runs.A?.kind).toBe("blocked");
      expect((await f.status()).runs.B).toBeUndefined();
      expect(f.messages.filter((item) => item.thread === "T-1")).toHaveLength(
        2,
      );
      if (legacy) {
        const db = new Database(join(f.root, ".git/factory/state.sqlite"));
        try {
          const verdict = db
            .query<{ detail: string }, []>(
              "SELECT detail FROM events WHERE ticket='A' AND action='review-verdict' ORDER BY id DESC LIMIT 1",
            )
            .get()!.detail;
          db.query("UPDATE runs SET data=? WHERE ticket='A'").run(
            JSON.stringify({
              kind: "blocked",
              thread: "T-1",
              reason: `Verification failed twice: ${verdict}`,
            }),
          );
          db.query(
            "UPDATE events SET detail=? WHERE ticket='A' AND action='review-verdict'",
          ).run(
            JSON.stringify({ ...JSON.parse(verdict), revision: "unrelated" }),
          );
          expect(f.resume()).rejects.toThrow(/evidence/);
          db.query(
            "UPDATE events SET detail=? WHERE ticket='A' AND action='review-verdict'",
          ).run(verdict);
          const reportPath = join(f.root, ".git/factory/A.report.json");
          const report = await readFile(reportPath, "utf8");
          await rm(reportPath);
          expect(f.resume()).rejects.toThrow(/evidence/);
          await writeFile(reportPath, report);
        } finally {
          db.close();
        }
      }
      f.reload();
      f.observe("unknown");
      expect(f.resume()).rejects.toThrow(/idle/);
      f.observe("idle");
      await f.resume();
      expect(f.resume()).rejects.toThrow(/blocked/);
      const db = new Database(join(f.root, ".git/factory/state.sqlite"), {
        readonly: true,
      });
      try {
        const event = db
          .query<{ detail: string }, []>(
            "SELECT detail FROM events WHERE ticket='A' AND action='repair-resumed' ORDER BY id DESC LIMIT 1",
          )
          .get();
        expect(JSON.parse(event!.detail)).toEqual({
          decision:
            "Use the review reproduction to repair the shared value contract",
          attempt: 3,
          thread: "T-1",
        });
      } finally {
        db.close();
      }
      expect((await f.tick()).runs.A).toMatchObject({
        kind: "running",
        attempt: 3,
        thread: "T-1",
      });
      expect(f.messages.at(-1)?.message).toContain(
        "Use the review reproduction",
      );
      await f.submit(3);
      await f.tick();
      await f.verdict("issues");
      expect((await f.tick()).runs.A).toMatchObject({
        kind: "running",
        attempt: 4,
        thread: "T-1",
      });
      await f.submit(4);
      await f.tick();
      await f.verdict("issues");
      expect((await f.tick()).runs.A?.kind).toBe("blocked");
      await f.resume();
      await f.tick();
      await f.submit(5);
      await f.tick();
      expect((await f.status()).runs.A?.kind).toBe("running");
      await f.verdict();
      expect((await f.tick()).runs.A?.kind).toBe("done");
      expect(await readFile(join(f.root, "src/value"), "utf8")).toBe("value 5");
    } finally {
      await f.close();
    }
  },
);

test("invalid and unavailable evidence cannot approve or replace a reviewer across reloads", async () => {
  const f = await fixture();
  try {
    await f.submit(1);
    await f.tick();
    f.reload();
    await Promise.all([f.tick(), f.tick()]);
    expect(f.watched.filter((thread) => thread === "T-2")).toHaveLength(2);
    const review = await f.review();
    for (const invalid of [
      "{",
      "null",
      "[]",
      JSON.stringify({ kind: "pass" }),
    ]) {
      await writeFile(review.report, invalid);
      expect((await f.tick()).runs.A).toMatchObject({
        kind: "running",
        attempt: 1,
      });
    }
    for (const patch of [
      { ticket: "B" },
      { attempt: 99 },
      { revision: review.base },
      { base: "stale" },
      { stage: "candidate" },
      { kind: "blocked" },
      { kind: "failed" },
      { findings: [{}] },
      { kind: "issues", findings: [] },
      { kind: ["issues"], findings: [finding] },
      { kind: "issues", findings: [{ ...finding, severity: ["critical"] }] },
    ]) {
      await f.verdict("pass", patch);
      expect((await f.tick()).runs.A).toMatchObject({
        kind: "running",
        attempt: 1,
      });
    }
    await f.verdict();
    for (const state of [
      "unknown",
      "running",
      "error",
      "awaiting-approval",
    ] as const) {
      f.observe(state);
      expect((await f.tick()).runs.A?.kind).toBe("running");
    }
    expect(f.settings).toHaveLength(2);
    expect(f.messages).toHaveLength(2);
    f.observe("idle");
    expect((await f.tick()).runs.A?.kind).toBe("done");
  } finally {
    await f.close();
  }
});

test.each(["base", "code", "stage"])(
  "changed %s invalidates approval",
  async (change) => {
    const f = await fixture();
    try {
      await f.submit(1);
      await f.tick();
      await f.verdict();
      const paths = {
        base: f.root,
        code: f.worktree,
        stage: (await f.review()).worktree,
      };
      const path = paths[change as keyof typeof paths];
      await writeFile(join(path, "src/value"), "changed");
      git(path, "add", ".");
      git(path, "commit", "-qm", "identity changed");
      expect((await f.tick()).runs.A?.kind).toBe("blocked");
      expect(f.settings).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
);

test.each(["create", "send"])(
  "ambiguous reviewer %s stays owned and parked",
  async (failure) => {
    const f = await fixture({}, undefined, failure);
    try {
      await f.submit(1);
      expect(f.tick()).rejects.toThrow(/unknown/);
      f.reload();
      await f.tick();
      expect((await f.tick()).runs.A?.kind).toBe("running");
      expect(f.settings).toHaveLength(2);
      expect(f.messages).toHaveLength(failure === "create" ? 1 : 2);
      expect((await f.status()).runs.B).toBeUndefined();
      expect(await readFile(join(f.root, "src/value"), "utf8")).toBe("old");
    } finally {
      await f.close();
    }
  },
);

test("ticket sizing and blast radius are validated independently", () => {
  const base = {
    id: "A",
    brief: "Requirements and blast-radius evidence",
    after: [],
  };
  expect(tasks([{ ...base, size: "small", risky: true }])[0]).toMatchObject({
    size: "small",
    risky: true,
  });
  for (const size of [null, true, "Small", "", 3])
    expect(() => tasks([{ ...base, size }])).toThrow(/size/);
  for (const risky of [null, "false", 0, []])
    expect(() => tasks([{ ...base, risky }])).toThrow(/risky/);
});
