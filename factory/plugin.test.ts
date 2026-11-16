import { expect, spyOn, test } from "bun:test";
import type { PluginAPI, PluginToolContext } from "@ampcode/plugin";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "./dashboard";
import registerFactory from "./plugin";
import { factoryStatus, openPersistence, type Run } from "./persistence";
import { watchdogFixture } from "./bookkeeping.fixture";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function deliveryTranscript(history: string, message: string) {
  const transcript = Array.from(
    { length: history === "truncated" ? 2000 : 21 },
    (_, index) => ({
      role: "assistant",
      id: `M-${index}`,
      content: [{ type: "text", text: message }],
    }),
  );
  if (history === "present" || history === "ambiguous")
    transcript[20]!.role = "user";
  if (history === "ambiguous")
    transcript.push({
      role: "user",
      id: "M-duplicate",
      content: [{ type: "text", text: message }],
    });
  if (history === "partial-key")
    transcript.push({
      role: "user",
      id: "M-partial",
      content: [
        { type: "text", text: `${message.split("\n")[0]}\nAltered assignment` },
      ],
    });
  if (history === "duplicate-row") transcript[1]!.id = "M-0";
  return transcript;
}

test.each([
  ["present", { kind: "running", delivery: "sent" }, 0, 1],
  ["absent", { kind: "running", delivery: "sent" }, 1, 1],
  ["ambiguous", { kind: "uncertain" }, 0, 2],
  ["failed", { kind: "uncertain" }, 0, 0],
  ["truncated", { kind: "uncertain" }, 0, 0],
  ["partial-key", { kind: "uncertain" }, 0, 0],
  ["duplicate-page", { kind: "uncertain" }, 0, 0],
  ["duplicate-row", { kind: "uncertain" }, 0, 0],
  ["legacy", { kind: "uncertain" }, 0, 0],
  ["paused", { kind: "running", delivery: "sending" }, 0, 0],
  ["denied", { kind: "running", delivery: "sending" }, 0, 0],
  ["status", { kind: "running", delivery: "sending" }, 0, 0],
] as const)(
  "delivery transcript lookup preserves duplicate safety with %s history",
  async (history, expected, expectedSends, deliveries) => {
    const root = await mkdtemp(join(tmpdir(), "factory-delivery-"));
    const directory = join(root, ".git/factory");
    const key = "a".repeat(64);
    const message = `factory-key: ${key}\nPrivate assignment`;
    const transcript = deliveryTranscript(history, message);
    let reads = 0;
    let sends = 0;
    let creates = 0;
    let execute!: (
      input: Record<string, unknown>,
      ctx: PluginToolContext,
    ) => Promise<unknown>;
    let dispose = () => {};
    try {
      git(root, "init", "-qb", "main");
      git(root, "config", "user.name", "Fixture");
      git(root, "config", "user.email", "fixture@example.invalid");
      await writeFile(join(root, "prd.md"), "Delivery fixture");
      const queue = [{ id: "A", brief: "Private assignment", after: [] }];
      await writeFile(join(root, "tickets.json"), JSON.stringify(queue));
      await writeFile(
        join(root, ".factory.json"),
        JSON.stringify({
          version: 1,
          capacity: 1,
          workerModel: "openai/gpt-6.1-sol",
          prd: "prd.md",
          tickets: "tickets.json",
          scope: ["src/"],
          verify: "true",
          permissions: {
            execute: history !== "denied",
            publish: false,
            externalTickets: false,
          },
        }),
      );
      git(root, "add", ".");
      git(root, "commit", "-qm", "fixture");
      const storage = openPersistence(directory, queue);
      storage.commit(
        {
          enabled: history !== "paused",
          owner: "T-owner",
          runs: {
            A: {
              kind: "running",
              thread: "T-worker",
              base: git(root, "rev-parse", "HEAD"),
              worktree: root,
              attempt: 1,
              delivery: "sending",
              ...(history === "legacy"
                ? {}
                : { deliveryIntent: { key, message, repeated: false } }),
            },
          },
        },
        "A",
        "fixture",
        "",
      );
      storage.close();
      const amp = {
        createAgent() {
          creates++;
          throw new Error("No replacement allowed");
        },
        threads: {
          get(id: string) {
            return {
              async appendUserMessage(value: { content: string }) {
                if (id === "T-owner") return;
                expect(id).toBe("T-worker");
                expect(value.content).toBe(message);
                sends++;
                transcript.push({
                  role: "user",
                  id: "M-sent",
                  content: [{ type: "text", text: value.content }],
                });
              },
              async messages(options: {
                full: boolean;
                from: string;
                offset: number;
                limit: number;
              }) {
                expect(id).toBe("T-worker");
                expect(options).toEqual({
                  full: true,
                  from: "start",
                  offset: options.offset,
                  limit: 20,
                });
                reads++;
                if (history === "failed")
                  throw new Error("History unavailable");
                const offset =
                  history === "duplicate-page" ? 0 : options.offset;
                return transcript.slice(offset, offset + options.limit);
              },
              state: {
                async get() {
                  return "running";
                },
                subscribe() {
                  return { unsubscribe() {} };
                },
              },
              title: {
                subscribe() {
                  return { unsubscribe() {} };
                },
              },
            };
          },
        },
        logger: { log() {} },
        on() {},
        registerTool(tool: { execute: typeof execute }) {
          execute = tool.execute;
        },
        onDispose(fn: () => void) {
          dispose = fn;
        },
      } as unknown as PluginAPI;
      registerFactory(amp, root, () => ({
        async init() {},
        async close() {},
        ledger: { async record() {} },
      }));
      const ctx = { thread: { id: "T-owner" } } as unknown as PluginToolContext;
      const action = history === "status" ? "status" : "reconcile";
      await execute({ action }, ctx);
      await execute({ action }, ctx);
      const state = factoryStatus(directory);
      expect(state.runs.A).toMatchObject({ ...expected, thread: "T-worker" });
      if (expected.kind === "uncertain")
        expect(state.runs.A?.incident).toMatchObject({
          reason: "delivery-unknown",
          recovery: "inspect",
        });
      expect(sends).toBe(expectedSends);
      expect(creates).toBe(0);
      expect(
        transcript.filter(
          (row) => row.role === "user" && row.content[0]?.text === message,
        ),
      ).toHaveLength(deliveries);
      if (["legacy", "paused", "denied", "status"].includes(history))
        expect(reads).toBe(0);
      if (history === "truncated") expect(reads).toBe(200);
    } finally {
      dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function recordedMergeFixture(action: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-merge-"));
  const directory = join(root, ".git/factory");
  const worktree = join(directory, "worktrees/A");
  const canary = "PRIVATE-MERGE-BRIEF-CANARY";
  let effects = 0;
  const queue = ["A", "legacy", "queued"].map((id) => ({
    id,
    brief: canary,
    after: [],
  }));
  let execute!: (
    input: Record<string, unknown>,
    ctx: PluginToolContext,
  ) => Promise<unknown>;
  let dispose = () => {};
  let server: ReturnType<typeof startDashboard> | undefined;
  try {
    git(root, "init", "-qb", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "prd.md"), canary);
    await writeFile(join(root, "tickets.json"), JSON.stringify(queue));
    await writeFile(
      join(root, ".factory.json"),
      JSON.stringify({
        version: 1,
        capacity: 1,
        workerModel: "openai/gpt-6.1-sol",
        prd: "prd.md",
        tickets: "tickets.json",
        scope: ["src/"],
        verify: "false",
        permissions: {
          execute: false,
          publish: false,
          externalTickets: false,
        },
      }),
    );
    await writeFile(join(root, "value"), "context\nbefore\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-qb", "accepted");
    await writeFile(join(root, "value"), "context\nafter\n");
    git(root, "commit", "-qam", "accepted change");
    const revision = git(root, "rev-parse", "HEAD");
    git(root, "worktree", "add", "--detach", worktree, revision);
    git(root, "checkout", "-q", "main");
    await writeFile(join(root, "value"), "main context\nbefore\n");
    await writeFile(join(root, "unrelated"), "main moved\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "unrelated");
    const missing = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-qb", "integration");
    const pick = spawnSync("git", ["-C", root, "cherry-pick", revision], {
      encoding: "utf8",
    });
    expect(pick.status).toBe(1);
    await writeFile(join(root, "value"), "main context\nafter\n");
    git(root, "add", "value");
    git(root, "cherry-pick", "--continue");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(revision);
    git(root, "checkout", "-q", "main");
    git(root, "merge", "--no-ff", "-qm", "merge PR", "integration");
    const commit = git(root, "rev-parse", "HEAD");
    const at = new Date(
      git(root, "show", "-s", "--format=%cI", commit),
    ).toISOString();
    git(
      root,
      "remote",
      "add",
      "origin",
      "git@github.com:example/merge-fixture.git",
    );
    git(root, "update-ref", "refs/remotes/origin/main", commit);
    git(root, "branch", "--set-upstream-to=origin/main", "main");
    const storage = openPersistence(directory, queue);
    const done = {
      kind: "done" as const,
      revision,
      thread: "T-worker" as const,
      insight: canary,
    };
    const blocked: Run = {
      kind: "blocked",
      thread: "T-worker",
      reason: "Gate failed twice",
      repair: {
        kind: "running",
        thread: "T-worker",
        base,
        worktree,
        attempt: 2,
        delivery: "sent",
      },
      incident: {
        id: "current-stop",
        ticket: "A",
        owner: "T-owner",
        base,
        attempt: 2,
        reason: "verification-rejected",
        recovery: "resume",
        delivery: "sent",
      },
    };
    storage.commit(
      {
        enabled: false,
        owner: "T-owner",
        runs: {
          A:
            action === "record-landing"
              ? blocked
              : { ...done, acceptedBase: base },
          legacy: done,
        },
      },
      "factory",
      "fixture",
      canary,
    );
    storage.close();
    const amp = {
      threads: {
        get() {
          effects++;
          throw new Error("record-merge must not observe or dispatch threads");
        },
      },
      logger: { log() {} },
      on() {},
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
      onDispose(fn: () => void) {
        dispose = fn;
      },
    } as unknown as PluginAPI;
    registerFactory(amp, root, () => ({
      async init() {},
      async close() {},
      ledger: {
        async record() {
          effects++;
          throw new Error("record-merge must not accept work");
        },
      },
    }));
    server = startDashboard({ root, port: 0 });
    const status = async () => {
      const response = await fetch(
        `http://localhost:${server!.port}/api/status`,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(canary);
      expect(text).not.toContain("caller.invalid");
      return JSON.parse(text);
    };
    expect(
      (await status()).tasks.map((task: { merge: unknown }) => task.merge),
    ).toEqual([null, null, null]);
    const request = {
      action,
      ticket: "A",
      pr: 42,
      commit,
      revision,
      incident: "current-stop",
      decision: "Operator verified external landing",
      url: `https://caller.invalid/${canary}`,
    };
    const owner = {
      thread: { id: "T-owner" },
      tools: {
        async call() {
          effects++;
          throw new Error("record-merge must not touch schedules or dispatch");
        },
      },
    } as unknown as PluginToolContext;
    for (const id of ["T-worker", "T-stranger"])
      expect(
        execute(request, { thread: { id } } as unknown as PluginToolContext),
      ).rejects.toThrow();
    for (const invalid of [
      { ticket: "queued" },
      { ticket: "unknown" },
      { commit: revision },
      { commit: missing },
      { pr: 0 },
      { pr: -1 },
      { pr: 1.5 },
      { pr: "42" },
      { pr: Number.MAX_SAFE_INTEGER + 1 },
      { commit: "main" },
      { commit: "f".repeat(40) },
      ...(action === "record-landing"
        ? [
            { incident: "stale-stop" },
            { incident: undefined },
            { decision: " " },
            { decision: undefined },
            { revision: "main" },
            { revision: commit },
            { revision: undefined },
          ]
        : []),
    ])
      expect(execute({ ...request, ...invalid }, owner)).rejects.toThrow();
    expect(execute({ ...request, commit: base }, owner)).rejects.toThrow(
      /does not contain the accepted change/,
    );
    expect((await status()).tasks[0].merge).toBeNull();
    await execute(request, owner);
    const saved = factoryStatus(directory);
    expect(saved).toMatchObject({
      enabled: false,
      owner: "T-owner",
      runs: {
        A: {
          kind: "done",
          revision,
          acceptedBase: base,
          merge: { pr: 42, commit, at },
        },
      },
    });
    const bytes = await readFile(join(directory, "state.sqlite"));
    await execute(request, owner);
    expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
    for (const conflict of [{ pr: 43 }, { commit: missing }])
      expect(execute({ ...request, ...conflict }, owner)).rejects.toThrow(
        /Conflicting/,
      );
    const queued = { kind: "creating" as const, base, worktree: "/unused" };
    const enabled = openPersistence(directory, queue);
    enabled.commit(
      { ...saved, enabled: true, runs: { ...saved.runs, queued } },
      "factory",
      "fixture",
      "enabled",
    );
    enabled.close();
    expect(execute({ ...request, ticket: "queued" }, owner)).rejects.toThrow(
      /done ticket|blocked ticket/,
    );
    await execute(
      { ...request, action: "record-merge", ticket: "legacy" },
      owner,
    );
    const body = await status();
    expect(body.enabled).toBe(true);
    expect(factoryStatus(directory).runs.queued).toEqual(queued);
    expect(effects).toBe(0);
    expect(body.tasks[0].merge).toEqual({
      pr: 42,
      url: "https://github.com/example/merge-fixture/pull/42",
      commit,
      at,
    });
    expect(body.tasks[1].merge).toEqual(body.tasks[0].merge);
    expect(body.tasks[2].merge).toBeNull();
    for (const remote of [
      "https://github.com/example/merge-fixture.git",
      "ssh://git@github.com/example/merge-fixture.git",
    ]) {
      git(root, "remote", "set-url", "origin", remote);
      expect((await status()).tasks[0].merge.url).toBe(
        "https://github.com/example/merge-fixture/pull/42",
      );
    }
    for (const remote of [
      "https://gitlab.com/example/repo.git",
      "https://github.com.evil.invalid/example/repo",
      "https://github.com/example/repo?private=secret",
    ]) {
      git(root, "remote", "set-url", "origin", remote);
      expect((await status()).tasks[0].merge).toEqual({
        pr: 42,
        url: null,
        commit,
        at,
      });
    }
  } finally {
    dispose();
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["record-merge", "record-landing"])(
  "owner %s proves a cherry-picked patch across changed context and publishes only curated metadata",
  recordedMergeFixture,
);

test("plugin and HTTP keep private briefs and native titles out of public titles", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-plugin-privacy-"));
  const directory = join(root, ".git/factory");
  const canary = "PRIVATE-INSTRUCTIONS-CANARY";
  const revision = "a".repeat(40);
  const base = "b".repeat(40);
  const ids = [
    "queued",
    "failed",
    "missing",
    "native",
    "accepted",
    "review",
    "reviewed",
  ];
  const queue = ids.map((id) => ({
    id,
    brief: canary,
    after: [],
    ...(id === "queued"
      ? { intake: "planned" as const, outcome: "Public result" }
      : {}),
    steps: ["Verify public identity"],
  }));
  let dispose = () => {};
  let server: ReturnType<typeof startDashboard> | undefined;
  let execute!: (
    input: Record<string, unknown>,
    ctx: PluginToolContext,
  ) => Promise<unknown>;
  const forwarded: { id: string; content: unknown }[] = [];
  try {
    git(root, "init", "-q");
    await writeFile(join(root, "prd.md"), "Fixture");
    await writeFile(join(root, "tickets.json"), JSON.stringify(queue));
    await writeFile(
      join(root, ".factory.json"),
      JSON.stringify({
        version: 1,
        capacity: 1,
        workerModel: "openai/gpt-6.1-sol",
        prd: "prd.md",
        tickets: "tickets.json",
        scope: ["src/"],
        verify: "true",
        permissions: { execute: false, publish: false, externalTickets: false },
      }),
    );
    const storage = openPersistence(directory, queue);
    const running = {
      kind: "running" as const,
      base,
      worktree: canary,
      attempt: 1,
      thread: "T-worker" as const,
      delivery: "sent" as const,
    };
    const review = {
      ticket: "review",
      attempt: 1,
      revision,
      base,
      stage: "post-graft" as const,
      worktree: canary,
      model: "anthropic/reviewer" as const,
      report: canary,
      log: canary,
      command: canary,
      delivery: "sent" as const,
      thread: "T-review" as const,
    };
    storage.commit(
      {
        enabled: false,
        owner: "T-owner",
        runs: {
          failed: { ...running, thread: "T-failed" },
          missing: { ...running, thread: "T-missing" },
          native: running,
          accepted: {
            kind: "done",
            revision,
            thread: "T-worker",
            insight: canary,
          },
          review: { ...running, review },
          reviewed: {
            kind: "done",
            revision,
            thread: "T-worker",
            insight: canary,
            review: { ...review, ticket: "reviewed" },
          },
        },
      },
      "factory",
      "fixture",
      canary,
    );
    storage.close();
    const bytes = await readFile(join(directory, "state.sqlite"));
    const amp = {
      threads: {
        get(id: string) {
          return {
            async appendUserMessage(message: { content: unknown }) {
              forwarded.push({ id, content: message.content });
            },
            state: {
              async get() {
                return "running";
              },
              subscribe() {
                return { unsubscribe() {} };
              },
            },
            title: {
              async get() {
                if (id === "T-failed") throw new Error("title unavailable");
                return id === "T-missing" ? null : canary;
              },
              subscribe() {
                return { unsubscribe() {} };
              },
            },
          };
        },
      },
      logger: { log() {} },
      on() {},
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
      onDispose(fn: () => void) {
        dispose = fn;
      },
    } as unknown as PluginAPI;
    registerFactory(amp, root, () => ({
      async init() {},
      async close() {},
      ledger: { async record() {} },
    }));
    const worker = {
      thread: { id: "T-worker" },
    } as unknown as PluginToolContext;
    const contact = {
      action: "message-foreman",
      message: "Need baseline decision",
    };
    await execute(contact, worker);
    expect(forwarded).toEqual([
      {
        id: "T-owner",
        content: expect.stringContaining("T-worker: Need baseline decision"),
      },
    ]);
    expect(execute({ ...contact, message: " " }, worker)).rejects.toThrow(
      /nonempty/,
    );
    expect(
      execute(contact, {
        thread: { id: "T-stranger" },
      } as unknown as PluginToolContext),
    ).rejects.toThrow(/worker/);
    expect(
      execute(
        {
          action: "resume",
          ticket: "native",
          decision: "Override",
          incident: "stale",
        },
        worker,
      ),
    ).rejects.toThrow(/Workers/);
    expect(forwarded).toHaveLength(1);
    const path = join(directory, "dashboard.json");
    for (let i = 0; !existsSync(path) && i < 1200; i++) await Bun.sleep(5);
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    server = startDashboard({ root, port: 0 });
    const response = await fetch(`http://localhost:${server.port}/api/status`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(canary);
    expect(JSON.stringify(snapshot)).not.toContain(canary);
    const expected = ids.map((id) => ({
      id,
      title: ["review", "reviewed"].includes(id)
        ? `${id} - post-graft review (sent)`
        : id,
      steps: ["Verify public identity"],
    }));
    expect(snapshot.tasks).toMatchObject(expected);
    expect(JSON.parse(body).tasks).toMatchObject(
      expected.map((task) =>
        task.id === "reviewed"
          ? { ...task, title: "reviewed", thread: "T-worker" }
          : task,
      ),
    );
    expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
    for (const id of ["T-worker", "T-review", "T-stranger"])
      expect(
        execute({ action: "admit", ticket: "queued" }, {
          thread: { id },
        } as unknown as PluginToolContext),
      ).rejects.toThrow();
    const owner = { thread: { id: "T-owner" } } as unknown as PluginToolContext;
    await execute({ action: "admit", ticket: "queued" }, owner);
    await execute({ action: "admit", ticket: "queued" }, owner);
    const admitted = await (
      await fetch(`http://localhost:${server.port}/api/status`)
    ).json();
    expect(
      admitted.tasks.find((task: { id: string }) => task.id === "queued"),
    ).toMatchObject({
      status: "queued",
      outcome: "Public result",
      thread: null,
    });
    expect(admitted.enabled).toBe(false);
  } finally {
    dispose();
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

async function damageCandidate(
  gate: string,
  root: string,
  worktree: string,
  reportPath: string,
  base: string,
) {
  if (gate === "revision") {
    await writeFile(
      reportPath,
      JSON.stringify({ kind: "candidate", attempt: 1, revision: base }),
    );
  } else if (gate === "dirty") {
    await writeFile(join(worktree, "src/value"), "dirty");
  } else if (gate === "integration") {
    await writeFile(join(root, "prd.md"), "# Changed target\n");
    git(root, "add", "prd.md");
    git(root, "commit", "-qm", "target moved");
  } else {
    const path = gate === "scope" ? "outside" : "src/value";
    await writeFile(join(worktree, path), "bad");
    git(worktree, "add", path);
    git(worktree, "commit", "-qm", "invalid candidate");
    await writeFile(
      reportPath,
      JSON.stringify({
        kind: "candidate",
        attempt: 1,
        revision: git(worktree, "rev-parse", "HEAD"),
      }),
    );
  }
}

test.each([
  ["valid", 1, undefined, "local"],
  ["revision", 2, undefined, "local"],
  ["dirty", 2, undefined, "local"],
  ["scope", 2, undefined, "local"],
  ["verification", 2, undefined, "local"],
  ["integration", 1, undefined, "local"],
  ["permission", 1, undefined, "local"],
  ["responsive", 1, undefined, "local"],
  ["review", 1, undefined, "local"],
  ["review", 1, "fixture-runner", { type: "runner", id: "fixture-runner" }],
  ["escalation", 3, undefined, "local"],
] as const)(
  "disconnected recovery preserves the %s gate at attempt %s on runner %s",
  async (gate, attempt, workerRunner, executor) => {
    const root = await mkdtemp(join(tmpdir(), "factory-plugin-"));
    const ready = join(root, ".git/factory/verify-ready");
    const release = join(root, ".git/factory/verify-release");
    const finished = join(root, ".git/factory/verify-finished");
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let dispose = () => {};
    let server: ReturnType<typeof startDashboard> | undefined;
    try {
      git(root, "init", "-q");
      server = startDashboard({ root, port: 0 });
      git(root, "config", "user.name", "Fixture");
      git(root, "config", "user.email", "fixture@example.invalid");
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src/value"), "old");
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      await writeFile(
        join(root, "tickets.json"),
        JSON.stringify([
          {
            id: "A",
            brief: "Repair value",
            after: [],
            steps: ["Repair the stored value", "Verify the public response"],
          },
        ]),
      );
      await writeFile(
        join(root, ".factory.json"),
        JSON.stringify({
          version: 1,
          capacity: 1,
          workerModel: "openai/gpt-6.1-sol",
          review: gate === "review",
          workerRunner,
          prd: "prd.md",
          tickets: "tickets.json",
          scope: ["src/"],
          verify:
            gate === "responsive"
              ? `test "$(cat src/value)" = good || exit 1; touch '${ready}'; for i in {1..100}; do if test -f '${release}'; then printf 'verified stdout'; printf 'verified stderr' >&2; touch '${finished}'; exit 0; fi; sleep 0.01; done; touch '${finished}'; exit 1`
              : 'test "$(cat src/value)" = good',
          permissions: {
            execute: true,
            publish: false,
            externalTickets: false,
          },
        }),
      );
      git(root, "add", ".");
      git(root, "commit", "-qm", "fixture");
      let creates = 0;
      const models: Parameters<PluginAPI["createAgent"]>[0][] = [];
      const executors: unknown[] = [];
      const sends: string[] = [];
      const notices: string[] = [];
      let noticeFails = false;
      const ledger: string[] = [];
      let disconnected = false;
      let readFails = false;
      let watchFails = false;
      let attachments = 0;
      let activeSubscriptions = 0;
      let activity = "running";
      let payload: unknown;
      let fallbackFails = false;
      let fallbackCalls = 0;
      let inFlight = 0;
      let finishedContextCalls = 0;
      let execute!: (
        input: {
          action: string;
          ticket?: string;
          decision?: string;
          incident?: string;
        },
        ctx: PluginToolContext,
      ) => Promise<unknown>;
      const subscription = () => {
        activeSubscriptions++;
        return {
          unsubscribe() {
            activeSubscriptions--;
          },
        };
      };
      const amp = {
        createAgent(options: Parameters<PluginAPI["createAgent"]>[0]) {
          models.push(options);
          return {
            async createThread(options: { executor: unknown }) {
              // Amp refuses runner threads while a tool call of the plugin is in flight.
              if (options.executor !== "local" && inFlight)
                throw new Error("Plugin agent threads spawned from tools");
              executors.push(options.executor);
              creates++;
              return { id: ["T-worker", "T-reviewer"][creates - 1] };
            },
          };
        },
        threads: {
          get(id: string) {
            return {
              async appendUserMessage(message: { content: string }) {
                if (id === "T-owner") {
                  notices.push(message.content);
                  if (noticeFails)
                    throw new Error("Append acknowledgment lost");
                } else sends.push(id);
              },
              get state() {
                if (disconnected)
                  throw new Error(
                    "thread.state is only available for connected threads",
                  );
                return {
                  async get() {
                    if (readFails)
                      throw new Error("connection lost during read");
                    return activity;
                  },
                  subscribe() {
                    attachments++;
                    return subscription();
                  },
                };
              },
              title: {
                async get() {
                  throw new Error("title unavailable");
                },
                subscribe() {
                  if (watchFails) throw new Error("observer unavailable");
                  return subscription();
                },
              },
            };
          },
        },
        logger: { log() {} },
        on() {},
        registerTool(tool: { execute: typeof execute }) {
          execute = async (input, context) => {
            let live = true;
            const scoped = {
              ...context,
              tools: context.tools && {
                async call(name: string, args: Record<string, unknown>) {
                  if (!live) finishedContextCalls++;
                  return context.tools.call(name, args);
                },
              },
            };
            inFlight++;
            try {
              return await tool.execute(input, scoped);
            } finally {
              live = false;
              inFlight--;
            }
          };
        },
        onDispose(fn: () => void) {
          dispose = fn;
        },
      } as unknown as PluginAPI;
      const watchdog = watchdogFixture();
      const ctx = {
        thread: { id: "T-owner" },
        tools: {
          async call(name: string, input: Record<string, unknown>) {
            if (name !== "amp.get_thread_status")
              return watchdog.tools.call(name, input);
            expect(name).toBe("amp.get_thread_status");
            expect(input).toEqual({ thread: "T-worker" });
            fallbackCalls++;
            if (fallbackFails) throw new Error("status unavailable");
            return payload;
          },
        },
      } as unknown as PluginToolContext;
      // A runner creation continues after the control call returns; status waits for that tick.
      const control = async (action: string, context = ctx) => {
        const result = JSON.parse(String(await execute({ action }, context)));
        return workerRunner
          ? JSON.parse(String(await execute({ action: "status" }, context)))
          : result;
      };
      const load = () =>
        registerFactory(amp, root, () => ({
          async init() {},
          async close() {},
          ledger: {
            async record(entry) {
              ledger.push(entry.sha);
            },
          },
        }));
      load();
      const original = (await control("start")).runs.A;
      expect(finishedContextCalls).toBe(0);
      expect(executors).toEqual([executor]);
      expect(original).toMatchObject({
        kind: "running",
        executor,
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
      });
      expect(models[0]).toMatchObject({
        tools: expect.arrayContaining(["send_thread_message"]),
      });
      await control("reconcile");
      expect(fallbackCalls).toBe(0);
      activity = "idle";
      expect((await control("reconcile")).runs.A).toEqual(original);
      readFails = true;
      payload = {
        metadata: { threadID: "T-worker" },
        agentState: { state: "idle" },
      };
      expect((await control("reconcile")).runs.A).toEqual(original);
      expect(
        (await Bun.file(join(root, ".git/factory/dashboard.json")).json())
          .tasks[0],
      ).toMatchObject({
        status: "idle",
        steps: ["Repair the stored value", "Verify the public response"],
      });
      readFails = false;
      const worktree = original.worktree;
      await writeFile(join(worktree, "src/value"), "good");
      git(worktree, "add", "src/value");
      git(worktree, "commit", "-qm", "candidate");
      const revision = git(worktree, "rev-parse", "HEAD");
      const reportPath = join(root, ".git/factory/A.report.json");
      await writeFile(
        reportPath,
        JSON.stringify({ kind: "candidate", attempt: 1, revision }),
      );
      const report = await readFile(reportPath, "utf8");
      disconnected = true;
      payload = undefined;
      dispose();
      load();
      expect((await control("status")).runs.A).toEqual(original);
      expect((await control("pause")).enabled).toBe(false);
      expect((await control("start")).runs.A).toEqual(original);
      for (const invalid of [
        undefined,
        null,
        [],
        "idle",
        { metadata: { threadID: "T-worker" } },
        { metadata: null, agentState: { state: "idle" } },
        { metadata: { threadID: "T-worker" }, agentState: null },
        { metadata: { threadID: "T-other" }, agentState: { state: "idle" } },
        {
          metadata: { threadID: "T-worker" },
          agentState: { state: "unknown" },
        },
        {
          metadata: { threadID: "T-worker" },
          agentState: { state: "completed" },
        },
      ]) {
        payload = invalid;
        expect((await control("reconcile")).runs.A).toEqual(original);
      }
      payload = {
        metadata: { threadID: "T-worker" },
        agentState: { state: "idle" },
      };
      fallbackFails = true;
      expect((await control("reconcile")).runs.A).toEqual(original);
      fallbackFails = false;
      const noContext = {
        ...ctx,
        tools: undefined,
      } as unknown as PluginToolContext;
      expect((await control("reconcile", noContext)).runs.A).toEqual(original);
      expect(await readFile(reportPath, "utf8")).toBe(report);
      expect(creates).toBe(1);
      expect(sends).toEqual(["T-worker"]);
      expect(ledger).toEqual([]);
      if (gate === "permission") {
        const configPath = join(root, ".factory.json");
        const saved = await readFile(configPath, "utf8");
        const disabled = JSON.parse(saved);
        disabled.permissions.execute = false;
        await writeFile(configPath, JSON.stringify(disabled));
        expect((await control("reconcile")).runs.A).toEqual(original);
        expect(ledger).toEqual([]);
        await writeFile(configPath, saved);
      } else if (!["valid", "responsive", "review"].includes(gate)) {
        await damageCandidate(gate, root, worktree, reportPath, original.base);
        const rejected = (await control("reconcile")).runs.A;
        expect(ledger).toEqual([]);
        expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
        expect(creates).toBe(1);
        if (gate === "integration") {
          expect(rejected).toMatchObject({
            kind: "blocked",
            thread: "T-worker",
            reason: "Integration target changed; reconcile before landing",
          });
          expect(sends).toEqual(["T-worker"]);
          return;
        }
        expect(rejected).toMatchObject({
          kind: "running",
          thread: "T-worker",
          attempt: 2,
          delivery: "sent",
        });
        expect(sends).toEqual(["T-worker", "T-worker"]);
        if (gate === "escalation") {
          noticeFails = true;
          await writeFile(
            reportPath,
            JSON.stringify({
              kind: "candidate",
              attempt: 2,
              revision: git(worktree, "rev-parse", "HEAD"),
            }),
          );
          expect((await control("reconcile")).runs.A).toMatchObject({
            kind: "blocked",
            thread: "T-worker",
          });
          const request = {
            action: "resume",
            ticket: "A",
            decision: "Repair the checked value",
            incident: (await control("status")).runs.A!.incident!.id,
          };
          expect(notices).toEqual([expect.stringContaining(request.incident)]);
          expect((await control("status")).runs.A.incident.delivery).toBe(
            "queued",
          );
          expect(notices).toHaveLength(1);
          noticeFails = false;
          dispose();
          load();
          await control("reconcile");
          expect(notices).toEqual([notices[0]!, notices[0]!]);
          expect((await control("status")).runs.A.incident.delivery).toBe(
            "sent",
          );
          expect(
            execute({ ...request, incident: "stale" }, ctx),
          ).rejects.toThrow(/exact current/);
          expect(execute({ action: "resume" }, ctx)).rejects.toThrow(
            /ticket and decision/,
          );
          expect(
            execute(request, {
              ...ctx,
              thread: { ...ctx.thread, id: "T-stranger" },
            }),
          ).rejects.toThrow(/Foreman/);
          const resumed = JSON.parse(String(await execute(request, ctx)));
          expect(resumed.runs.A).toMatchObject({
            kind: "running",
            thread: "T-worker",
            attempt: 3,
            delivery: "sent",
          });
          expect(sends).toEqual(["T-worker", "T-worker", "T-worker"]);
        }
        git(worktree, "reset", "--hard", revision);
        await writeFile(
          reportPath,
          JSON.stringify({
            kind: "candidate",
            attempt,
            revision,
          }),
        );
      }
      let responsive = false;
      if (gate === "responsive") {
        heartbeat = setInterval(() => {
          if (!existsSync(ready)) return;
          responsive = !existsSync(finished);
          const storage = openPersistence(join(root, ".git/factory"), []);
          storage.event(
            "factory",
            "verification-responsive",
            "independent write while verification waits",
          );
          storage.close();
          writeFileSync(release, "");
          clearInterval(heartbeat);
        }, 10);
      }
      async function reviewCandidate() {
        if (gate !== "review") return;
        const configPath = join(root, ".factory.json");
        const savedConfig = await readFile(configPath, "utf8");
        const nextConfig = JSON.parse(savedConfig);
        nextConfig.workerRunner = "next-runner";
        await writeFile(configPath, JSON.stringify(nextConfig));
        await control("reload");
        await writeFile(configPath, savedConfig);
        disconnected = false;
        const pending = (await control("reconcile")).runs.A;
        expect(pending).toMatchObject({
          kind: "running",
          review: {
            stage: "post-graft",
            thread: "T-reviewer",
            delivery: "sent",
            executor,
          },
        });
        expect(executors).toEqual([executor, executor]);
        expect(ledger).toEqual([]);
        expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
        expect(models[1]).toMatchObject({
          model: "anthropic/claude-fable-5-2",
          reasoningEffort: "high",
        });
        expect(models[1]?.instructions).toContain("Do not implement");
        expect(models[1]?.instructions).toContain(
          "the ce-code-review skill's SKILL.md and referenced files in the synced user skill caches",
        );
        const readDashboard = () =>
          Bun.file(join(root, ".git/factory/dashboard.json")).json();
        let dashboard = await readDashboard();
        // A deferred runner creation publishes after its control call has returned.
        for (
          let waits = 0;
          workerRunner &&
          dashboard.tasks[0].thread !== "T-reviewer" &&
          waits < 200;
          waits++
        ) {
          await Bun.sleep(10);
          dashboard = await readDashboard();
        }
        expect(dashboard.tasks[0]).toMatchObject({
          thread: "T-reviewer",
          revision,
        });
        expect(finishedContextCalls).toBe(0);
        expect(dashboard.tasks[0].title).toContain("post-graft review");
        expect(JSON.stringify(dashboard)).not.toContain(pending.review.report);
        const status = await (
          await fetch(`http://localhost:${server!.port}/api/status`)
        ).json();
        expect(status).toMatchObject({ durable: "available", fresh: true });
        expect(status.tasks[0]).toMatchObject({
          thread: "T-reviewer",
          revision,
          evidence: {
            acceptance: null,
            gate: { revision, base: original.base, stage: "post-graft" },
            review: { pending: true, revision, thread: "T-reviewer" },
          },
        });
        expect(JSON.stringify(status)).not.toContain(pending.review.report);
        expect(JSON.stringify(status)).not.toContain(pending.review.log);
        dispose();
        load();
        await control("reconcile");
        expect(creates).toBe(2);
        expect(sends).toEqual(["T-worker", "T-reviewer"]);
        await writeFile(
          pending.review.report,
          JSON.stringify({
            ticket: "A",
            attempt: 1,
            revision,
            base: original.base,
            stage: "post-graft",
            kind: "pass",
            findings: [],
          }),
        );
      }
      await reviewCandidate();
      const accepted = (await control("reconcile")).runs.A;
      async function checkResponsiveness() {
        if (gate !== "responsive") return;
        expect(responsive).toBe(true);
        expect(await readFile(join(root, ".git/factory/A-1.log"), "utf8")).toBe(
          "verified stdoutverified stderr",
        );
      }
      await checkResponsiveness();
      expect(accepted).toMatchObject({
        kind: "done",
        thread: "T-worker",
        revision,
        executor,
      });
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("good");
      expect((await control("reconcile")).runs.A).toEqual(accepted);
      expect(ledger).toEqual([revision]);
      if (gate === "review") {
        expect(creates).toBe(2);
        expect(sends).toEqual(["T-worker", "T-reviewer"]);
        expect(accepted.review.evidence).toContain('"kind":"pass"');
        expect(
          control("pause", {
            ...ctx,
            thread: { ...ctx.thread, id: "T-reviewer" },
          }),
        ).rejects.toThrow(/cannot control/);
        const completed = await Bun.file(
          join(root, ".git/factory/dashboard.json"),
        ).json();
        expect(completed.tasks[0]).toMatchObject({
          status: "accepted",
          thread: "T-reviewer",
          revision,
        });
        await rm(join(root, ".git/factory/dashboard.json"));
        const durable = await (
          await fetch(`http://localhost:${server!.port}/api/status`)
        ).json();
        expect(durable).toMatchObject({ fresh: false, observedAt: null });
        expect(durable.tasks[0]).toMatchObject({
          status: "accepted",
          revision,
          evidence: {
            acceptance: { revision },
            review: { pending: false, revision },
          },
        });
        return;
      }
      expect(creates).toBe(1);
      expect(sends).toEqual(Array(attempt).fill("T-worker"));

      dispose();
      disconnected = false;
      watchFails = true;
      const storage = openPersistence(join(root, ".git/factory"), []);
      storage.commit(
        {
          enabled: true,
          owner: "T-owner",
          runs: { A: original },
        },
        "A",
        "fixture-restored",
        "observer recovery",
      );
      storage.close();
      await rm(reportPath);
      load();
      expect((await control("reconcile")).runs.A).toEqual(original);
      expect(activeSubscriptions).toBe(0);
      const failedAttachments = attachments;
      expect((await control("status")).runs.A).toEqual(original);
      expect((await control("pause")).enabled).toBe(false);
      watchFails = false;
      expect((await control("start")).runs.A).toEqual(original);
      expect(attachments).toBeGreaterThan(failedAttachments);
      expect(activeSubscriptions).toBe(2);
    } finally {
      clearInterval(heartbeat);
      dispose();
      await server?.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("setup recovery control preserves durable failure and compatible observations across reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-plugin-setup-"));
  let dispose = () => {};
  try {
    git(root, "init", "-q");
    await writeFile(join(root, "prd.md"), "Fixture");
    await writeFile(
      join(root, "tickets.json"),
      JSON.stringify([{ id: "A", brief: "Work", after: [] }]),
    );
    await writeFile(
      join(root, ".factory.json"),
      JSON.stringify({
        version: 1,
        capacity: 1,
        workerModel: "openai/gpt-6.1-sol",
        prd: "prd.md",
        tickets: "tickets.json",
        scope: ["src/"],
        verify: "true",
        setup: `test -f '${root}/.git/setup-ready' || { echo dependencies-unavailable >&2; exit 17; }`,
        permissions: { execute: true, publish: false, externalTickets: false },
      }),
    );
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    let creates = 0;
    let sends = 0;
    const notices: string[] = [];
    let workerActivity = "running";
    let wake!: (
      event: { thread: { id: string } },
      ctx: PluginToolContext,
    ) => Promise<unknown>;
    let execute!: (
      input: { action: string },
      ctx: PluginToolContext,
    ) => Promise<unknown>;
    const subscription = () => ({ unsubscribe() {} });
    const amp = {
      createAgent() {
        return {
          async createThread() {
            creates++;
            return { id: "T-worker" };
          },
        };
      },
      threads: {
        get(id: string) {
          return {
            async appendUserMessage(message: { content: string }) {
              if (id === "T-owner") notices.push(message.content);
              else sends++;
            },
            state: {
              async get() {
                return workerActivity;
              },
              subscribe: subscription,
            },
            title: {
              async get() {
                return null;
              },
              subscribe: subscription,
            },
          };
        },
      },
      logger: { log() {} },
      on(_event: string, handler: typeof wake) {
        wake = handler;
      },
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
      onDispose(fn: () => void) {
        dispose = fn;
      },
    } as unknown as PluginAPI;
    const fixture = watchdogFixture();
    let bridgeFailed = true;
    let toolCalls = 0;
    const ctx = {
      thread: { id: "T-owner" },
      tools: {
        async call(name: string, input: Record<string, unknown>) {
          toolCalls++;
          if (bridgeFailed) throw new Error("Schedule bridge unavailable");
          return fixture.tools.call(name, input);
        },
      },
    } as unknown as PluginToolContext;
    const control = async (action: string) =>
      JSON.parse(String(await execute({ action }, ctx)));
    const load = () =>
      registerFactory(amp, root, () => ({
        async init() {},
        async close() {},
        ledger: { async record() {} },
      }));
    const observation = join(root, ".git/factory/dashboard.json");
    async function observed(status: string) {
      for (let i = 0; i < 1200; i++) {
        if (existsSync(observation)) {
          const snapshot = JSON.parse(await readFile(observation, "utf8"));
          if (snapshot.tasks[0].status === status) return snapshot.tasks[0];
        }
        await Bun.sleep(5);
      }
      throw new Error(`Observation never reached ${status}`);
    }
    const directory = join(root, ".git/factory");
    await mkdir(directory, { recursive: true });
    const storage = openPersistence(directory, []);
    storage.state.enabled = true;
    storage.state.owner = "T-owner";
    storage.commit(storage.state, "factory", "fixture-legacy", "");
    storage.close();
    load();
    await control("status");
    expect((await control("status")).runs).toEqual({});
    expect(creates).toBe(0);
    expect(toolCalls).toBe(0);
    const recovery = await wake({ thread: { id: "T-owner" } }, ctx);
    expect(recovery).toMatchObject({
      message: {
        display: true,
        content: expect.stringContaining(
          "Monitored execution is not confirmed",
        ),
      },
    });
    expect(creates).toBe(0);
    expect(toolCalls).toBe(1);
    const stranger = {
      ...ctx,
      thread: { id: "T-stranger" },
    } as unknown as PluginToolContext;
    for (const action of ["pause", "reconcile", "reload"]) {
      const stopped = JSON.parse(String(await execute({ action }, stranger)));
      expect(stopped.enabled).toBe(false);
    }
    expect(toolCalls).toBe(1);
    expect(creates).toBe(0);
    bridgeFailed = false;
    const failed = (await control("start")).runs.A;
    expect(failed).toMatchObject({
      kind: "preparation-failed",
      worktree: join(root, ".git/factory/worktrees/A"),
    });
    expect(await readFile(failed.log, "utf8")).toContain(
      "dependencies-unavailable",
    );
    expect(creates).toBe(0);
    expect(sends).toBe(0);
    expect(notices).toEqual([expect.stringContaining("Recovery: retry-setup")]);
    dispose();
    load();
    await ctx.tools.call("amp.clear_schedule", {});
    await wake({ thread: { id: "T-worker" } }, ctx);
    expect(await ctx.tools.call("amp.get_schedule", {})).toBeNull();
    await wake({ thread: { id: "T-owner" } }, ctx);
    expect(await ctx.tools.call("amp.get_schedule", {})).toMatchObject({
      enabled: true,
    });
    expect((await control("reconcile")).runs.A).toEqual(failed);
    expect(notices).toHaveLength(1);
    expect(await observed("blocked")).toMatchObject({
      status: "blocked",
      thread: null,
    });
    const server = startDashboard({ root, port: 0 });
    try {
      const status = await (
        await fetch(`http://localhost:${server.port}/api/status`)
      ).json();
      expect(status.tasks[0]).toMatchObject({
        status: "blocked",
        thread: null,
      });
      expect(JSON.stringify(status)).not.toContain(failed.log);
    } finally {
      await server.stop(true);
    }
    await writeFile(join(root, ".git/setup-ready"), "ready");
    bridgeFailed = true;
    expect((await control("retry-setup")).runs.A).toMatchObject({
      kind: "running",
      worktree: failed.worktree,
      attempt: 1,
      thread: "T-worker",
    });
    expect(creates).toBe(1);
    expect(sends).toBe(1);
    expect(await observed("working")).toMatchObject({
      status: "working",
      thread: "T-worker",
    });
    expect((await control("status")).monitor.problem).toContain("unavailable");
    bridgeFailed = false;
    workerActivity = "idle";
    const report = join(directory, "A.report.json");
    await writeFile(report, "not-json");
    const invalidReport = await wake({ thread: { id: "T-owner" } }, ctx);
    expect(invalidReport).toMatchObject({
      message: {
        display: true,
        content: expect.stringContaining("Factory reconciliation failed."),
      },
    });
    expect(JSON.stringify(invalidReport)).not.toContain(
      "Monitored execution is not confirmed",
    );
    await rm(report);
    workerActivity = "running";
    const beforePause = toolCalls;
    const worker = {
      ...ctx,
      thread: { id: "T-worker" },
    } as unknown as PluginToolContext;
    expect(await execute({ action: "pause" }, worker).catch(String)).toMatch(
      /Workers/,
    );
    expect(toolCalls).toBe(beforePause);
    expect(
      JSON.parse(String(await execute({ action: "pause" }, stranger))).enabled,
    ).toBe(false);
    expect(toolCalls).toBe(beforePause);
    expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
      enabled: true,
    });
    await wake({ thread: { id: "T-owner" } }, ctx);
    expect((await control("status")).monitor.schedule).toBe("cleared");
    expect(await fixture.tools.call("amp.get_schedule", {})).toBeNull();
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test.each([
  [false, false, { threadID: "T-worker" }, "sending", "T-worker", "resume"],
  [false, true, { threadID: "T-worker" }, "unknown", "T-worker", "resume"],
  [true, false, {}, "sending", "T-reviewer", "inspect"],
  [true, true, undefined, "unknown", "T-reviewer", "inspect"],
] as const)(
  "provider wait resumes the same thread once (review=%s, lost send=%s)",
  async (review, lostSend, metadata, heldOutcome, thread, errorRecovery) => {
    const root = await mkdtemp(join(tmpdir(), "factory-provider-"));
    const directory = join(root, ".git/factory");
    const queue = [{ id: "A", brief: "Private assignment", after: [] }];
    let at = Date.parse("2026-11-14T17:19:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => at);
    let dispose = () => {};
    let execute!: (
      input: Record<string, unknown>,
      ctx: PluginToolContext,
    ) => Promise<string>;
    const sent: { thread: string; content: string }[] = [];
    const notices: string[] = [];
    const fixture = watchdogFixture();
    let local = "error";
    let error: unknown = {
      code: "MODEL_PROVIDER_ERROR",
      message: `Provider failed: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "You've hit your 5-hour limit · resets 7pm (UTC)" } })}`,
    };
    let status = "error";
    let persisted!: Run;
    const amp = {
      threads: {
        get(id: string) {
          return {
            state: {
              async get() {
                return local;
              },
              subscribe() {
                return { unsubscribe() {} };
              },
            },
            title: {
              subscribe() {
                return { unsubscribe() {} };
              },
            },
            async appendUserMessage(message: { content: string }) {
              if (id === "T-owner") notices.push(message.content);
              if (id === thread) {
                expect(
                  factoryStatus(directory).runs.A?.incident?.providerLimit
                    ?.continuation?.outcome,
                ).toBe("sending");
                sent.push({ thread: id, content: message.content });
                if (lostSend) throw new Error("Lost acknowledgment");
              }
            },
          };
        },
      },
      logger: { log() {} },
      on() {},
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
      onDispose(fn: () => void) {
        dispose = fn;
      },
    } as unknown as PluginAPI;
    const tools: PluginToolContext["tools"] = {
      async call(name, input) {
        if (name === "amp.get_thread_status")
          return {
            metadata,
            agentState: { state: status },
            agentError: error,
          };
        return fixture.tools.call(name, input);
      },
    };
    const ctx = {
      thread: { id: "T-owner" },
      tools,
    } as unknown as PluginToolContext;
    const control = async (action = "reconcile", context = ctx) =>
      JSON.parse(await execute({ action }, context));
    const seed = () => {
      const storage = openPersistence(directory, queue);
      storage.commit(
        {
          enabled: true,
          owner: "T-owner",
          runs: { A: structuredClone(persisted) },
        },
        "A",
        "fixture",
        "",
      );
      storage.close();
    };
    try {
      git(root, "init", "-q");
      git(root, "config", "user.name", "Fixture");
      git(root, "config", "user.email", "fixture@example.invalid");
      await writeFile(join(root, "prd.md"), "Fixture");
      await writeFile(join(root, "tickets.json"), JSON.stringify(queue));
      await writeFile(
        join(root, ".factory.json"),
        JSON.stringify({
          version: 1,
          capacity: 1,
          workerModel: "openai/gpt-6.1-sol",
          prd: "prd.md",
          tickets: "tickets.json",
          scope: ["src/"],
          verify: "true",
          permissions: {
            execute: true,
            publish: false,
            externalTickets: false,
          },
        }),
      );
      git(root, "add", ".");
      git(root, "commit", "-qm", "fixture");
      const base = git(root, "rev-parse", "HEAD");
      persisted = {
        kind: "running",
        thread: "T-worker",
        base,
        worktree: root,
        attempt: 1,
        delivery: "sent",
        ...(review
          ? {
              review: {
                ticket: "A",
                attempt: 1,
                revision: base,
                base,
                stage: "post-graft" as const,
                worktree: root,
                model: "anthropic/reviewer" as const,
                report: join(directory, "review.json"),
                log: "fixture",
                command: "true",
                delivery: "sent" as const,
                thread: "T-reviewer" as const,
              },
            }
          : {}),
      };
      seed();
      registerFactory(amp, root, () => ({
        async init() {},
        async close() {},
        ledger: { async record() {} },
      }));
      const noTools = {
        ...ctx,
        tools: undefined,
      } as unknown as PluginToolContext;
      expect((await control("reconcile", noTools)).runs.A.incident.reason).toBe(
        "worker-error",
      );
      const first = (await control()).runs.A;
      expect(first).toMatchObject({
        kind: "running",
        attempt: 1,
        incident: {
          reason: "provider-limit",
          recovery: "wait",
          providerLimit: {
            thread,
            message: (error as { message: string }).message,
            observedAt: at,
            resetAt: Date.parse("2026-11-14T19:00:00Z"),
          },
        },
      });
      const id = first.incident.id;
      expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
        trigger: {
          schedule: "DTSTART:20261114T190100Z\nRRULE:FREQ=MINUTELY;INTERVAL=30",
        },
      });
      at = Date.parse("2026-11-14T18:59:59Z");
      await control();
      expect(sent).toEqual([]);
      await control("pause");
      at = Date.parse("2026-11-14T19:00:00Z");
      await control();
      expect(sent).toEqual([]);
      const after = (await control("start")).runs.A;
      expect(after.incident.id).toBe(id);
      expect(after.incident.providerLimit.continuation).toEqual({
        at,
        outcome: lostSend ? "unknown" : "sent",
      });
      expect(sent).toEqual([
        {
          thread,
          content: expect.stringContaining(
            "Continue the same factory assignment",
          ),
        },
      ]);
      const previousNotices = [...notices];
      expect(previousNotices).toContainEqual(
        expect.stringContaining("provider-limit"),
      );
      at += 1000;
      await control();
      expect((await control("status")).runs.A.incident.id).toBe(id);
      expect(sent).toHaveLength(1);
      expect(notices).toEqual(previousNotices);
      await control("reconcile", {
        ...ctx,
        tools: undefined,
      } as unknown as PluginToolContext);
      const storage = openPersistence(directory, queue);
      storage.state.runs.A!.incident!.providerLimit!.continuation!.outcome =
        heldOutcome;
      storage.commit(
        storage.state,
        "A",
        "fixture-crash",
        "Reserved before process exit",
      );
      storage.close();
      dispose();
      registerFactory(amp, root, () => ({
        async init() {},
        async close() {},
        ledger: { async record() {} },
      }));
      at += 1000;
      await control();
      expect(sent).toHaveLength(1);
      expect((await control("status")).runs.A.incident.id).toBe(id);
      expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
        trigger: {
          schedule: "DTSTART:20261114T143900Z\nRRULE:FREQ=MINUTELY;INTERVAL=30",
        },
      });
      local = status = "running";
      await control("reconcile", {
        ...ctx,
        tools: undefined,
      } as unknown as PluginToolContext);
      expect((await control("status")).runs.A.incident).toBeUndefined();

      local = status = "error";
      error = {
        code: "MODEL_PROVIDER_ERROR",
        message: JSON.stringify({
          error: { type: "rate_limit_error", message: "resets 12am (UTC)" },
        }),
      };
      const midnight = (await control()).runs.A.incident;
      expect(midnight.id).not.toBe(id);
      expect(midnight.providerLimit.resetAt).toBe(
        Date.parse("2026-11-15T00:00:00Z"),
      );
      seed();
      error = {
        code: "MODEL_PROVIDER_ERROR",
        message: JSON.stringify({
          error: { type: "rate_limit_error", message: "resets 7pm (UTC)" },
        }),
      };
      for (const observation of ["19:11", "20:19"]) {
        seed();
        at = Date.parse(`2026-11-14T${observation}:00Z`);
        const count = sent.length;
        expect((await control()).runs.A.incident.providerLimit.resetAt).toBe(
          Date.parse("2026-11-14T19:00:00Z"),
        );
        expect(sent).toHaveLength(count + 1);
        await control();
        expect(sent).toHaveLength(count + 1);
        expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
          trigger: {
            schedule:
              "DTSTART:20261114T143900Z\nRRULE:FREQ=MINUTELY;INTERVAL=30",
          },
        });
      }

      seed();
      at = Date.parse("2026-11-14T17:19:00Z");
      await control();
      local = status = "running";
      const beforeRecovery = sent.length;
      await control();
      expect(sent).toHaveLength(beforeRecovery + 1);
      await control();
      expect((await control("status")).runs.A.incident).toBeUndefined();
      local = status = "error";

      seed();
      at = Date.parse("2026-11-14T19:00:00Z");
      const continued = (await control()).runs.A.incident;
      at += 1000;
      error = {
        code: "MODEL_PROVIDER_ERROR",
        message: JSON.stringify({
          error: { type: "rate_limit_error", message: "resets 8pm (UTC)" },
        }),
      };
      const repeated = (await control()).runs.A.incident;
      if (lostSend) {
        expect(repeated.id).toBe(continued.id);
        expect(repeated.providerLimit.continuation.outcome).toBe("unknown");
      } else {
        expect(repeated.id).not.toBe(continued.id);
        expect(repeated.providerLimit.resetAt).toBe(
          Date.parse("2026-11-14T20:00:00Z"),
        );
        expect(repeated.providerLimit.continuation).toBeUndefined();
      }

      for (const recoverEarly of [false, true]) {
        seed();
        error = {
          code: "MODEL_PROVIDER_ERROR",
          message: JSON.stringify({
            error: {
              type: "rate_limit_error",
              message: recoverEarly ? "resets 7pm (Unknown)" : "Try later",
            },
          }),
        };
        const unknown = (await control()).runs.A.incident;
        expect(unknown).toMatchObject({
          reason: "provider-limit",
          recovery: "wait",
        });
        expect(unknown.providerLimit.resetAt).toBeUndefined();
        const count = sent.length;
        at += 1_799_999;
        await control();
        expect(sent).toHaveLength(count);
        if (recoverEarly) local = status = "running";
        else at++;
        await control();
        expect(sent).toHaveLength(count + 1);
        await control();
        expect(sent).toHaveLength(count + 1);
        local = status = "error";
      }
      for (const invalid of [
        null,
        {},
        { code: "OTHER", message: "rate_limit_error" },
        {
          code: "MODEL_PROVIDER_ERROR",
          message: "You've hit your limit · resets 7pm (UTC)",
        },
        {
          code: "MODEL_PROVIDER_ERROR",
          message:
            '{"error":{"type":"api_error","message":"resets 7pm (UTC)"}}',
        },
        {
          code: "MODEL_PROVIDER_ERROR",
          message: '{"error":{"type":"rate_limit_error"}}',
        },
      ]) {
        seed();
        error = invalid;
        expect((await control()).runs.A.incident).toMatchObject({
          reason: "worker-error",
          recovery: errorRecovery,
        });
      }
    } finally {
      dispose();
      clock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
