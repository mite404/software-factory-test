import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  configuration,
  effectiveDefinition,
  effectiveConfiguration,
  createFactory,
  tasks,
  type NativeHost,
} from "./native";
import { openStore } from "./bookkeeping.fixture";
import { startDashboard } from "./dashboard";
import { openPersistence } from "./persistence";

const installer = resolve(import.meta.dir, "setup-factory.ts");
const preparationRoots: string[] = [];

test("queue retains ordered step labels and rejects malformed labels", () => {
  const task = { id: "A", brief: "Private brief", after: [] };
  expect(
    tasks([
      {
        ...task,
        steps: [
          "Verify private field exclusion",
          "Preserve ordered task labels",
        ],
      },
    ])[0],
  ).toMatchObject({
    steps: ["Verify private field exclusion", "Preserve ordered task labels"],
  });
  expect(Object.hasOwn(tasks([task])[0]!, "steps")).toBe(false);
  expect(tasks([{ ...task, steps: [] }])[0]?.steps).toEqual([]);
  for (const steps of [
    null,
    "Label",
    {},
    [""],
    [" \t"],
    [7],
    ["Valid label", null],
  ])
    expect(() => tasks([{ ...task, steps }])).toThrow();
});

// A cold `bun` child on a shared CI runner has taken longer than one second to reach its marker.
async function waitForFile(path: string) {
  for (let i = 0; i < 2000 && !(await Bun.file(path).exists()); i++)
    await Bun.sleep(5);
  expect(await Bun.file(path).exists()).toBe(true);
}

function waitingSetup(root: string) {
  return `echo setup-started; touch '${root}/.git/setup-running'; for i in {1..500}; do test -f '${root}/.git/release' && break; sleep 0.01; done; test -f '${root}/.git/release' || exit 1; `;
}

async function preparationFixture(
  setup: (root: string) => string,
  timeoutMs = 60000,
) {
  const root = await mkdtemp(join(tmpdir(), "factory-preparation-"));
  preparationRoots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  for (const file of ["package.json", "bun.lock", "lefthook.yml"])
    await copyFile(join(import.meta.dir, "..", file), join(root, file));
  await writeFile(join(root, "prd.md"), "Fixture");
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
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
      setup: `${setup(root)}mkdir -p node_modules && printf prepared > node_modules/ready`,
      setupTimeoutMs: timeoutMs,
      permissions: { execute: true, publish: false, externalTickets: false },
    }),
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const worktree = join(root, ".git/factory/worktrees/A");
  let creates = 0;
  let sends = 0;
  const ready = async () =>
    expect(await readFile(join(worktree, "node_modules/ready"), "utf8")).toBe(
      "prepared",
    );
  const host: NativeHost = {
    async create() {
      await ready();
      creates++;
      return "T-prepared";
    },
    async send(id) {
      if (id === "T-owner") return;
      await ready();
      sends++;
    },
    async state() {
      return "running";
    },
    watch() {},
  };
  const factory = (now?: () => number) =>
    createFactory(root, host, openStore, now);
  return {
    root,
    worktree,
    host,
    factory,
    git,
    counts: () => ({ creates, sends }),
  };
}

afterEach(async () => {
  for (const root of preparationRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("watchdog bounds suspicion across reload, diagnostics, unknown activity and read-only reads", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const clock = () => at;
  const engine = f.factory(clock);
  await engine.tick("start", "T-owner");
  const nudges: string[] = [];
  f.host.send = async (thread, message) => {
    expect(thread).toBe("T-owner");
    nudges.push(message);
    throw new Error("Ambiguous delivery");
  };
  at += 1_799_999;
  await engine.tick("reconcile");
  expect(nudges).toEqual([]);
  const storage = openPersistence(engine.directory, [], clock);
  storage.event("A", "error", "Diagnostic only");
  storage.event("A", "observation-unavailable", "Diagnostic only");
  storage.state.runs.B = {
    kind: "done",
    thread: "T-other",
    revision: f.git("rev-parse", "HEAD"),
    insight: "Unrelated progress",
  };
  storage.commit(storage.state, "B", "accepted", "abc");
  storage.close();
  at++;
  const bytes = await readFile(join(engine.directory, "state.sqlite"));
  await engine.tick("status");
  const server = startDashboard({ root: f.root, port: 0 });
  try {
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/api/status`)).status,
    ).toBe(200);
  } finally {
    await server.stop();
  }
  expect(await readFile(join(engine.directory, "state.sqlite"))).toEqual(bytes);
  expect(nudges).toEqual([]);
  f.host.state = async () => "unknown";
  const suspected = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(suspected).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    attempt: 1,
  });
  expect(suspected.watchdog).toMatchObject({
    progressAt: 1000,
    nudgedAt: 1_801_000,
  });
  expect(suspected.watchdog!.alerts).toEqual([
    expect.objectContaining({
      kind: "unresolved",
      attempt: 1,
      intendedAt: 1_801_000,
    }),
  ]);
  expect(nudges).toEqual([expect.stringContaining("Diagnose current status")]);
  at += 1_799_999;
  await f.factory(clock).tick("reconcile");
  expect(nudges).toHaveLength(1);
  at++;
  const second = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(nudges).toHaveLength(2);
  expect(second.watchdog!.alerts).toEqual(suspected.watchdog!.alerts);
  expect(second.watchdog!.progressAt).toBe(1000);
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
  await engine.tick("pause");
  at += 3_600_000;
  await f.factory(clock).tick("reconcile");
  expect(nudges).toHaveLength(2);
});

test("a crash after nudge reservation retains alert intent without immediate redelivery", async () => {
  const f = await preparationFixture(() => "");
  const engine = f.factory(() => 1000);
  await engine.tick("start", "T-owner");
  const child = spawnSync(process.execPath, [
    "--eval",
    `
      import { createFactory } from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
      import { openStore } from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
      const host = {
        async create() { throw new Error("No replacement"); },
        async send() { process.exit(23); },
        async state() { return "unknown"; }, watch() {},
      };
      await createFactory(${JSON.stringify(f.root)}, host, openStore, () => 1801000).tick("reconcile");
    `,
  ]);
  expect(child.status).toBe(23);
  const reserved = (await engine.tick("status")).runs.A!;
  expect(reserved.watchdog).toMatchObject({ nudgedAt: 1_801_000 });
  expect(reserved.watchdog!.alerts).toHaveLength(1);
  const nudges: string[] = [];
  f.host.send = async (_id, message) => {
    nudges.push(message);
  };
  await f.factory(() => 1_801_000).tick("reconcile");
  expect(nudges).toEqual([]);
  const retried = (await f.factory(() => 3_601_000).tick("reconcile")).runs.A!;
  expect(nudges).toHaveLength(1);
  expect(retried.watchdog!.alerts).toEqual(reserved.watchdog!.alerts);
  expect(retried).toMatchObject({
    kind: "running",
    attempt: 1,
    thread: "T-prepared",
  });
  expect(f.counts().creates).toBe(1);
});

test("stop notices do not reset an incident clock and repair opens a fresh episode", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const clock = () => at;
  const engine = f.factory(clock);
  await engine.tick("start", "T-owner");
  f.host.state = async () => "idle";
  const report = join(engine.directory, "A.report.json");
  await writeFile(
    report,
    JSON.stringify({ kind: "blocked", attempt: 1, reason: "PRIVATE" }),
  );
  f.host.send = async () => {
    throw new Error("Notice unavailable");
  };
  const stopped = (await engine.tick("reconcile")).runs.A!;
  at += 900_000;
  const notices: string[] = [];
  f.host.send = async (_id, message) => {
    notices.push(message);
  };
  const notified = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(notified.incident).toMatchObject({
    notifiedAt: 901_000,
    delivery: "sent",
  });
  expect(notified.watchdog!.progressAt).toBe(1000);
  at += 900_000;
  const suspected = (await engine.tick("reconcile")).runs.A!;
  expect(suspected.watchdog!.alerts).toHaveLength(1);
  expect(notices).toHaveLength(2);
  expect(notices[1]).toContain(stopped.incident!.id);
  expect(notices.join("\n")).not.toContain("PRIVATE");
  const storage = openPersistence(engine.directory, [], clock);
  storage.state.runs.A!.watchdog!.alerts[0]!.acknowledgedAt = at;
  storage.commit(
    storage.state,
    "A",
    "alert-acknowledged",
    "fixture delivery receipt",
  );
  storage.close();
  const resumed = (
    await f.factory(clock).tick("resume", "T-owner", f.host.state, {
      ticket: "A",
      incident: stopped.incident!.id,
      decision: "Inspected baseline",
    })
  ).runs.A!;
  expect(resumed).toMatchObject({
    kind: "running",
    attempt: 2,
    thread: "T-prepared",
  });
  expect(resumed.watchdog!.episode).not.toBe(suspected.watchdog!.episode);
  expect(resumed.watchdog!.alerts[0]!.acknowledgedAt).toBe(1_801_000);
  at += 1_800_000;
  const again = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(
    again.watchdog!.alerts.filter((alert) => alert.kind === "unresolved"),
  ).toHaveLength(2);
  expect(again.watchdog!.alerts[0]!.acknowledgedAt).toBe(1_801_000);
  expect(f.counts().creates).toBe(1);
});

test("repair spending alerts at six and ten without parking or replacing the worker", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const clock = () => at;
  const engine = f.factory(clock);
  await engine.tick("start", "T-owner");
  f.host.state = async () => "idle";
  for (let attempt = 1; attempt <= 10; attempt++) {
    const before = (await f.factory(clock).tick("status")).runs.A!;
    expect(before).toMatchObject({
      kind: "running",
      attempt,
      thread: "T-prepared",
    });
    expect(
      before
        .watchdog!.alerts.filter((alert) => alert.kind === "spending")
        .map((alert) => alert.attempt),
    ).toEqual(attempt < 6 ? [] : attempt < 10 ? [6] : [6, 10]);
    if (attempt === 10) break;
    at += 1000;
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        kind: "candidate",
        attempt,
        revision: f.git("rev-parse", "HEAD"),
      }),
    );
    const result = await f.factory(clock).tick("reconcile");
    if (attempt % 2 === 0) {
      expect(result.runs.A!.kind).toBe("blocked");
      await f.factory(clock).tick("resume", "T-owner", f.host.state, {
        ticket: "A",
        incident: result.runs.A!.incident!.id,
        decision: "Reviewed failed candidate",
      });
    } else expect(result.runs.A!.kind).toBe("running");
    await f.factory(clock).tick("reconcile");
  }
  expect(f.counts()).toEqual({ creates: 1, sends: 10 });
});

test("legacy timing adopts once; complete and dependency-only work stay quiet", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const clock = () => at;
  const engine = f.factory(clock);
  await engine.tick("start", "T-owner");
  const storage = openPersistence(engine.directory, [], clock);
  delete storage.state.runs.A!.watchdog;
  storage.commit(storage.state, "A", "legacy-fixture", "No watchdog fields");
  storage.close();
  at = 10_000_000;
  const adopted = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(adopted.watchdog).toMatchObject({ progressAt: at, alerts: [] });
  const messages: string[] = [];
  f.host.send = async (_id, message) => {
    messages.push(message);
  };
  at += 1_800_000;
  const suspected = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(suspected.watchdog!.alerts).toHaveLength(1);
  const finished = openPersistence(engine.directory, [], clock);
  finished.state.runs.A = {
    kind: "done",
    thread: "T-prepared",
    revision: "abc",
    insight: "Complete",
    watchdog: suspected.watchdog,
  };
  finished.commit(finished.state, "A", "accepted", "abc");
  finished.close();
  at += 9_000_000;
  await f.factory(clock).tick("reconcile");
  expect(messages).toHaveLength(1);
  await engine.tick("pause");
  const empty = openPersistence(engine.directory, [], clock);
  empty.state.runs = {};
  empty.state.enabled = true;
  empty.commit(empty.state, "factory", "fixture", "Dependency waiting only");
  empty.close();
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([
      { id: "A", brief: "Waiting A", after: ["B"] },
      { id: "B", brief: "Waiting B", after: ["A"] },
    ]),
  );
  await f.factory(clock).tick("reconcile");
  expect(messages).toHaveLength(1);
  expect((await engine.tick("status")).runs).toEqual({});
});

test("watchdog policy validates in the project definition and pins active runs", async () => {
  const f = await preparationFixture(() => "");
  const path = join(f.root, ".factory.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  for (const watchdog of [
    null,
    {},
    { suspicionMs: 0, spendingFirstAttempt: 6, spendingInterval: 4 },
    { suspicionMs: 100, spendingFirstAttempt: 6, spendingInterval: 4, typo: 1 },
    { suspicionMs: 100, spendingFirstAttempt: 1.5, spendingInterval: 4 },
  ]) {
    await writeFile(path, JSON.stringify({ ...raw, watchdog }));
    expect(configuration(f.root)).rejects.toThrow(/watchdog/);
  }
  await writeFile(
    path,
    JSON.stringify({
      ...raw,
      watchdog: {
        suspicionMs: 100,
        spendingFirstAttempt: 6,
        spendingInterval: 4,
      },
    }),
  );
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "policy",
  );
  let at = 1000;
  const clock = () => at;
  await f.factory(clock).tick("start", "T-owner");
  await writeFile(
    path,
    JSON.stringify({
      ...raw,
      watchdog: {
        suspicionMs: 10_000,
        spendingFirstAttempt: 6,
        spendingInterval: 4,
      },
    }),
  );
  await f.factory(clock).tick("reload", "T-owner");
  at += 100;
  const suspected = (await f.factory(clock).tick("reconcile")).runs.A!;
  expect(suspected.watchdog!.alerts).toHaveLength(1);
  expect(suspected.watchdog!.nudgedAt).toBe(1100);
});

test("a rejected stop transaction cannot publish or resurrect its notice", async () => {
  const f = await preparationFixture(() => "");
  await f.factory().tick("start", "T-owner");
  f.host.state = async () => "idle";
  const directory = join(f.root, ".git/factory");
  await writeFile(
    join(directory, "A.report.json"),
    JSON.stringify({ kind: "blocked", attempt: 1, reason: "Inspect baseline" }),
  );
  const notices: string[] = [];
  f.host.send = async (_id, message) => {
    notices.push(message);
  };
  const db = new Database(join(directory, "state.sqlite"));
  db.run(`CREATE TRIGGER fail_stop BEFORE INSERT ON events WHEN NEW.action = 'blocked'
    BEGIN SELECT RAISE(ABORT, 'stop rollback'); END`);
  expect(f.factory().tick("reconcile")).rejects.toThrow(/stop rollback/);
  const unchanged = (await f.factory().tick("status")).runs.A!;
  expect(unchanged).toMatchObject({ kind: "running", attempt: 1 });
  expect(unchanged.incident).toBeUndefined();
  expect(notices).toEqual([]);
  db.run("DROP TRIGGER fail_stop");
  db.close();
  const stopped = (await f.factory().tick("reconcile")).runs.A!;
  expect(stopped).toMatchObject({
    kind: "blocked",
    incident: { recovery: "resume", delivery: "sent" },
  });
  expect(notices).toEqual([expect.stringContaining(stopped.incident!.id)]);
});

test("ownerless parked work does not record nonexistent notice transitions", async () => {
  const f = await preparationFixture(() => "");
  await f.factory().tick("pause");
  const directory = join(f.root, ".git/factory");
  const storage = openPersistence(directory, []);
  storage.state.runs.A = {
    kind: "creating",
    base: f.git("rev-parse", "HEAD"),
    worktree: f.worktree,
  };
  storage.commit(storage.state, "A", "creating", "fixture");
  storage.close();
  const bytes = await readFile(join(directory, "state.sqlite"));
  await f.factory().tick("reconcile");
  await f.factory().tick("reconcile");
  expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test.each(["crash-before-send", "failed-send", "append-before-ack"])(
  "stop notices survive %s and bind repair to the current incident",
  async (fault) => {
    const f = await preparationFixture(() => "");
    await f.factory().tick("start", "T-owner");
    const directory = join(f.root, ".git/factory");
    const report = join(directory, "A.report.json");
    const privateReason = "PRIVATE-CANARY diagnosis needed";
    await writeFile(
      report,
      JSON.stringify({ kind: "blocked", attempt: 1, reason: privateReason }),
    );
    f.host.state = async () => "idle";
    const notices: { id: string; message: string }[] = [];
    f.host.send = async (id, message) => {
      notices.push({ id, message });
      if (fault === "failed-send") throw new Error("Transport unavailable");
    };
    if (fault === "crash-before-send") {
      const child = spawnSync(process.execPath, [
        "--eval",
        `
        import { createFactory } from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
        import { openStore } from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
        const host = {
          async create() { throw new Error("No replacement"); },
          async send(id) { if (id === "T-owner") process.exit(23); },
          async state() { return "idle"; }, watch() {},
        };
        await createFactory(${JSON.stringify(f.root)}, host, openStore).tick("reconcile");
      `,
      ]);
      expect(child.status).toBe(23);
    } else {
      const db = new Database(join(directory, "state.sqlite"));
      if (fault === "append-before-ack")
        db.run(`
        CREATE TRIGGER fail_ack BEFORE INSERT ON events WHEN NEW.action = 'notice-sent'
        BEGIN SELECT RAISE(ABORT, 'ack lost'); END
      `);
      await f.factory().tick("reconcile");
      if (fault === "append-before-ack") db.run("DROP TRIGGER fail_ack");
      db.close();
      expect(notices).toHaveLength(1);
    }
    const pending = (await f.factory().tick("status")).runs.A!;
    expect(pending).toMatchObject({
      kind: "blocked",
      incident: {
        ticket: "A",
        owner: "T-owner",
        attempt: 1,
        base: f.git("rev-parse", "HEAD"),
        reason: "worker-blocked",
        recovery: "resume",
        delivery: "queued",
      },
    });
    const bytes = await readFile(join(directory, "state.sqlite"));
    const count = notices.length;
    const server = startDashboard({ root: f.root, port: 0 });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/status`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(privateReason);
    } finally {
      await server.stop();
    }
    await f.factory().tick("status");
    expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
    expect(notices).toHaveLength(count);
    f.host.send = async (id, message) => {
      notices.push({ id, message });
    };
    await f.factory().tick("pause");
    await f.factory().tick("reconcile");
    expect(notices).toHaveLength(count + 1);
    expect(notices.at(-1)).toEqual({
      id: "T-owner",
      message: expect.stringContaining(pending.incident!.id),
    });
    expect(JSON.stringify(notices)).not.toContain(privateReason);
    const request = {
      ticket: "A",
      decision: "Baseline restored",
      incident: pending.incident!.id,
    };
    await f.factory().tick("resume", "T-owner", f.host.state, request);
    expect((await f.factory().tick("status")).enabled).toBe(false);
    await f.factory().tick("start", "T-owner");
    await writeFile(
      report,
      JSON.stringify({ kind: "blocked", attempt: 2, reason: "error" }),
    );
    const later = (await f.factory().tick("reconcile")).runs.A!;
    expect(later.incident!.id).not.toBe(request.incident);
    expect(later.incident!.attempt).toBe(2);
    expect(later.incident!.reason).toBe("worker-blocked");
    expect(
      f.factory().tick("resume", "T-owner", f.host.state, request),
    ).rejects.toThrow(/exact current/);
    expect((await f.factory().tick("status")).runs.A).toEqual(later);
    const storage = openPersistence(directory, []);
    storage.state.owner = "T-new-owner";
    storage.commit(storage.state, "factory", "owner-replaced", "fixture");
    storage.close();
    await f.factory().tick("reconcile");
    const reassigned = (await f.factory().tick("status")).runs.A!;
    expect(reassigned.incident!.owner).toBe("T-new-owner");
    expect(reassigned.incident!.id).not.toBe(later.incident!.id);
    expect(notices.at(-1)).toEqual({
      id: "T-new-owner",
      message: expect.stringContaining(reassigned.incident!.id),
    });
    expect(
      f.factory().tick("resume", "T-new-owner", f.host.state, {
        ...request,
        incident: later.incident!.id,
      }),
    ).rejects.toThrow(/exact current/);
    const engine = f.factory();
    const results = await Promise.allSettled([
      engine.tick("resume", "T-new-owner", f.host.state, {
        ...request,
        incident: reassigned.incident!.id,
      }),
      engine.tick("resume", "T-new-owner", f.host.state, {
        ...request,
        incident: reassigned.incident!.id,
      }),
    ]);
    expect(results.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await f.factory().tick("status")).runs.A).toMatchObject({
      kind: "running",
      thread: "T-prepared",
      attempt: 3,
    });
    expect(f.counts().creates).toBe(1);
  },
);

test.each([false, true])(
  "owner resumes a preflight blocker in the original worker (legacy=%s)",
  async (legacy) => {
    const f = await preparationFixture(() => "");
    await f.factory().tick("start", "T-owner");
    await f.factory().tick("reconcile");
    const original = (await f.factory().tick("status")).runs.A!;
    expect(original.kind).toBe("running");
    const directory = join(f.root, ".git/factory");
    await writeFile(
      join(directory, "A.report.json"),
      JSON.stringify({
        kind: "blocked",
        attempt: 1,
        reason: "Missing baseline",
      }),
    );
    f.host.state = async () => "idle";
    const state = await f.factory().tick("reconcile");
    expect(state.runs.A).toMatchObject({
      kind: "blocked",
      thread: "T-prepared",
    });
    await f.factory().tick("pause");
    if (legacy) {
      const db = openPersistence(directory, []);
      db.state.runs.A = {
        kind: "blocked",
        thread: "T-prepared",
        reason: "Missing baseline",
      };
      db.commit(
        db.state,
        "factory",
        "legacy-fixture",
        "Plain pre-upgrade block",
      );
      db.close();
    }
    const incident = (await f.factory().tick("reconcile")).runs.A!.incident!.id;
    const request = {
      ticket: "A",
      decision: "Baseline restored; continue",
      incident,
    };
    expect(
      f.factory().tick("resume", "T-prepared", f.host.state, request),
    ).rejects.toThrow(/Workers/);
    expect(
      f.factory().tick("resume", "T-stranger", f.host.state, request),
    ).rejects.toThrow(/Foreman/);
    expect(
      f.factory().tick("resume", "T-owner", async () => "unknown", request),
    ).rejects.toThrow(/idle/);
    await writeFile(join(f.worktree, "unfinished"), "retain");
    expect(
      f.factory().tick("resume", "T-owner", f.host.state, request),
    ).rejects.toThrow(/changed/);
    await rm(join(f.worktree, "unfinished"));
    const resumed = await f
      .factory()
      .tick("resume", "T-owner", f.host.state, request);
    expect(resumed.enabled).toBe(false);
    expect(resumed.runs.A).toMatchObject({
      kind: "running",
      thread: "T-prepared",
      attempt: 2,
      delivery: "queued",
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    expect(
      f.factory().tick("resume", "T-owner", f.host.state, request),
    ).rejects.toThrow(/blocked/);
    const base = f.git("rev-parse", "HEAD");
    f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "moved base",
    );
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow(/changed/);
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    f.git("reset", "--hard", base);
    await f.factory().tick("start", "T-owner");
    await f.factory().tick("reconcile");
    expect((await f.factory().tick("status")).runs.A).toMatchObject({
      kind: "running",
      attempt: 2,
      delivery: "sent",
      thread: "T-prepared",
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 2 });
  },
);

test.each(["{", "{}", '[{"id":"A","brief":"","after":[]}]'])(
  "malformed queue %s is refused before storage opens",
  async (queue) => {
    const f = await preparationFixture(() => "true; ");
    await writeFile(join(f.root, "tickets.json"), queue);
    for (const flag of ["--check", "--effective", "--migrate"]) {
      const result = spawnSync("bun", [installer, "--repo", f.root, flag], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
    }
    const engine = createFactory(f.root, f.host, () => {
      throw new Error("Must reject before storage");
    });
    for (const action of ["status", "start", "reload", "reconcile"] as const)
      expect(engine.tick(action, "T-owner")).rejects.toThrow(
        /JSON|Tickets|text/,
      );
    expect(
      await Bun.file(join(engine.directory, "state.sqlite")).exists(),
    ).toBe(false);
  },
);

test.each(["restart", "worker retry", "empty retry"])(
  "unloaded edits stay unloaded after %s",
  async (action) => {
    const f = await preparationFixture(() => "true; ");
    const path = join(f.root, ".factory.json");
    const raw = await Bun.file(path).json();
    await writeFile(
      join(f.root, "tickets.json"),
      JSON.stringify([
        { id: "A", brief: "First", after: [] },
        { id: "B", brief: "Second", after: [] },
      ]),
    );
    f.git("add", ".");
    f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "queue",
    );
    const engine = f.factory();
    await engine.tick("start", "T-owner");
    const before = await effectiveDefinition(f.root);
    await writeFile(join(f.root, "future-tickets.json"), "[]");
    await writeFile(
      path,
      JSON.stringify({
        ...raw,
        review: true,
        verify: "false",
        tickets: "future-tickets.json",
      }),
    );
    f.git("add", ".");
    f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "future definition",
    );
    const next = action === "restart" ? f.factory() : engine;
    if (action !== "restart") {
      const bytes = await readFile(join(engine.directory, "state.sqlite"));
      expect(
        next.tick(
          "retry-setup",
          action === "worker retry" ? "T-prepared" : "T-owner",
        ),
      ).rejects.toThrow();
      expect(await readFile(join(engine.directory, "state.sqlite"))).toEqual(
        bytes,
      );
    }
    expect(await effectiveDefinition(f.root)).toEqual(before);
    expect((await effectiveConfiguration(f.root)).tickets).toBe(
      join(f.root, "tickets.json"),
    );
    const saved = await readFile(join(engine.directory, "state.sqlite"));
    const effective = spawnSync(
      "bun",
      [installer, "--repo", f.root, "--effective"],
      { encoding: "utf8" },
    );
    expect(effective.status).toBe(0);
    expect(JSON.parse(effective.stdout)).toEqual(before);
    const server = startDashboard({ root: f.root, port: 0 });
    try {
      expect(
        await (
          await fetch(`http://127.0.0.1:${server.port}/api/definition`)
        ).json(),
      ).toEqual(before);
    } finally {
      await server.stop(true);
    }
    expect(await readFile(join(engine.directory, "state.sqlite"))).toEqual(
      saved,
    );
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        attempt: 1,
        kind: "blocked",
        reason: "Fixture stopped",
      }),
    );
    f.host.state = async () => "idle";
    f.host.create = async () => "T-second";
    f.host.send = async () => {};
    const state = await next.tick("reconcile");
    expect(JSON.stringify(state.runs.B?.definition)).toContain(before.digest);
  },
);

test("reload pins future definitions while active checks, scope and instructions survive restart", async () => {
  const f = await preparationFixture(() => "true; ");
  const path = join(f.root, ".factory.json");
  const raw = await Bun.file(path).json();
  raw.verify = 'test "$(cat src/value)" = good';
  raw.backup = {
    repository: "private/backup-target",
    projectKey: "hidden-backup-key",
  };
  raw.permissions.backup = true;
  await writeFile(path, JSON.stringify(raw));
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([
      { id: "A", brief: "First", after: [] },
      { id: "B", brief: "Second", after: ["A"] },
    ]),
  );
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "pin fixture",
  );
  const original = await configuration(f.root);
  const messages: string[] = [];
  let creates = 0;
  f.host.create = async () => `T-pin-${++creates}`;
  f.host.send = async (_thread, message) => {
    messages.push(message);
  };
  const first = f.factory();
  const started = await first.tick("start", "T-owner");
  const pin = started.runs.A?.definition;
  expect(pin).toBe(original.digest);
  expect(messages[0]).not.toContain("backup");
  expect(JSON.stringify(pin)).not.toContain("hidden-backup-key");
  const reopened = f.factory();
  expect((await reopened.tick("status")).runs.A?.definition).toEqual(pin);
  const changed = {
    ...raw,
    scope: ["docs/"],
    verify: "false",
    review: true,
    workerModel: "anthropic/claude-sonnet-4.6",
  };
  await writeFile(path, JSON.stringify(changed));
  await writeFile(join(f.root, "prd.md"), "Changed future instructions");
  const future = await configuration(f.root);
  expect(future.digest).not.toBe(original.digest);
  const beforeReload = await readFile(join(reopened.directory, "state.sqlite"));
  expect((await reopened.tick("reload", "T-owner")).runs.A?.definition).toEqual(
    pin,
  );
  expect(await readFile(join(reopened.directory, "state.sqlite"))).not.toEqual(
    beforeReload,
  );
  const afterReload = await readFile(join(reopened.directory, "state.sqlite"));
  expect((await effectiveDefinition(f.root)).digest).toBe(future.digest);
  const refused = createFactory(f.root, f.host, () => {
    throw new Error("Must authorize before opening bookkeeping");
  });
  expect(refused.tick("reload", "T-pin-1")).rejects.toThrow(
    /Workers cannot control/,
  );
  await writeFile(path, JSON.stringify({ ...changed, version: 2 }));
  expect(reopened.tick("reload", "T-owner")).rejects.toThrow(/version 1/);
  expect(await readFile(join(reopened.directory, "state.sqlite"))).toEqual(
    afterReload,
  );
  await writeFile(path, JSON.stringify(raw));
  await writeFile(join(f.root, "prd.md"), "Fixture");
  await mkdir(join(f.worktree, "src"));
  await writeFile(join(f.worktree, "src/value"), "good");
  f.git("-C", f.worktree, "add", "src/value");
  f.git(
    "-C",
    f.worktree,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "candidate",
  );
  const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
  await writeFile(
    join(reopened.directory, "A.report.json"),
    JSON.stringify({ attempt: 1, kind: "candidate", revision }),
  );
  f.host.state = async () => "idle";
  const settled = await f.factory().tick("reconcile");
  expect(settled.runs.A).toMatchObject({
    kind: "done",
    revision,
    definition: pin,
  });
  expect(settled.runs.B).toMatchObject({
    kind: "running",
    definition: future.digest,
    workerModel: "anthropic/claude-sonnet-4.6",
  });
  expect(messages[1]).not.toContain("Changed future instructions");
  expect(messages[1]).toContain("Allowed paths: docs/. Check: false.");
});

test("definition rename is rejected and private instructions stay deduplicated", async () => {
  const f = await preparationFixture(() => "true; ");
  const raw = await Bun.file(join(f.root, ".factory.json")).json();
  await mkdir(join(f.root, "factory"));
  await writeFile(
    join(f.root, "factory/definition.yaml"),
    JSON.stringify({ ...raw, scope: ["factory/"] }),
  );
  await rm(join(f.root, ".factory.json"));
  const instructions = "Private PRD paragraph. ".repeat(2000);
  await writeFile(join(f.root, "prd.md"), instructions);
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "definition",
  );
  const messages: string[] = [];
  f.host.send = async (_thread, message) => {
    messages.push(message);
  };
  const engine = f.factory();
  const started = await engine.tick("start", "T-owner");
  expect(JSON.stringify(started).length).toBeLessThan(2000);
  f.git(
    "-C",
    f.worktree,
    "mv",
    "factory/definition.yaml",
    "factory/notes.yaml",
  );
  f.git(
    "-C",
    f.worktree,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "rename",
  );
  const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({ attempt: 1, kind: "candidate", revision }),
  );
  f.host.state = async () => "idle";
  const rejected = await engine.tick("reconcile");
  expect(rejected.runs.A).toMatchObject({ kind: "running", attempt: 2 });
  expect(await Bun.file(join(f.root, "factory/definition.yaml")).exists()).toBe(
    true,
  );
  expect(messages.join("\n")).not.toContain("Private PRD paragraph");
  expect(JSON.stringify(rejected).length).toBeLessThan(2000);
  const db = new Database(join(engine.directory, "state.sqlite"), {
    readonly: true,
  });
  try {
    expect(db.query("SELECT count(*) AS n FROM definitions").get()).toEqual({
      n: 1,
    });
    const stored = JSON.stringify(
      db.query("SELECT data FROM definitions").all(),
    );
    expect(stored).toContain("Private PRD paragraph");
    expect(
      JSON.stringify(
        db
          .query("SELECT data FROM runs UNION ALL SELECT detail FROM events")
          .all(),
      ),
    ).not.toContain("Private PRD paragraph");
  } finally {
    db.close();
  }
});

test.each(["", "bun install --frozen-lockfile && "])(
  "setup %s finishes before worker creation and delivery",
  async (command) => {
    const f = await preparationFixture(() => command);
    expect(
      await Bun.file(join(f.worktree, "node_modules/ready")).exists(),
    ).toBe(false);
    const factory = f.factory();
    await Promise.all([
      factory.tick("start", "T-owner"),
      factory.tick("reconcile"),
    ]);
    await f.factory().tick("reconcile");
    expect((await factory.tick("status")).runs.A).toMatchObject({
      kind: "running",
      attempt: 1,
      worktree: f.worktree,
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    if (command) {
      expect(
        await Bun.file(
          join(f.worktree, "node_modules/oxlint/package.json"),
        ).exists(),
      ).toBe(true);
      expect(await readFile(join(f.worktree, "bun.lock"), "utf8")).toBe(
        await readFile(join(f.root, "bun.lock"), "utf8"),
      );
    }
  },
  90000,
);

test.each(
  ["setup", "gate"].flatMap((stage) =>
    ["none", "SSH_CLIENT", "SSH2_CLIENT"].map((ssh) => ({ stage, ssh })),
  ),
)(
  "$stage preserves nested Bash dependency lookup with $ssh and noninteractive stdin",
  async ({ stage, ssh }) => {
    const saved = {
      SSH_CLIENT: process.env.SSH_CLIENT,
      SSH2_CLIENT: process.env.SSH2_CLIENT,
    };
    delete process.env.SSH_CLIENT;
    delete process.env.SSH2_CLIENT;
    if (ssh !== "none") process.env[ssh] = "controlled-shell-fixture";
    try {
      const f = await preparationFixture(() => "");
      const home = join(f.root, ".git/shell-home");
      await mkdir(join(home, "bin"), { recursive: true });
      await writeFile(
        join(home, ".bashrc"),
        'echo startup-interference >> "$HOME/startup-marker"\nexport PATH=/usr/bin:/bin\n',
      );
      const dependency = join(home, "bin/factory-fixture-dependency");
      await writeFile(
        dependency,
        "#!/bin/sh\nif read -r input; then exit 1; fi\necho dependency-ready\n",
      );
      await chmod(dependency, 0o755);
      const command = `env SHLVL=0 HOME='${home}' PATH='${home}/bin:/usr/bin:/bin' bash -c 'factory-fixture-dependency'`;
      const configPath = join(f.root, ".factory.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (stage === "setup") config.setup = `${command} && ${config.setup}`;
      else config.verify = command;
      await writeFile(configPath, JSON.stringify(config));
      f.git("add", ".factory.json");
      f.git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "configure nested shell",
      );
      const factory = f.factory();
      expect((await factory.tick("start", "T-owner")).runs.A).toMatchObject({
        kind: "running",
        attempt: 1,
      });
      await mkdir(join(f.worktree, "src"));
      await writeFile(join(f.worktree, "src/value"), "good");
      f.git("-C", f.worktree, "add", "src/value");
      f.git(
        "-C",
        f.worktree,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "candidate",
      );
      const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
      await writeFile(
        join(factory.directory, "A.report.json"),
        JSON.stringify({ kind: "candidate", attempt: 1, revision }),
      );
      f.host.state = async () => "idle";
      expect((await factory.tick("reconcile")).runs.A).toMatchObject({
        kind: "done",
        revision,
      });
      expect(await Bun.file(join(home, "startup-marker")).exists()).toBe(false);
      if (stage === "gate")
        expect(await readFile(join(factory.directory, "A-1.log"), "utf8")).toBe(
          "dependency-ready\n",
        );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.each([
  { command: "touch setup-marker; ", path: "setup-marker", content: "" },
  { command: "printf x >> prd.md; ", path: "prd.md", content: "Fixturex" },
])(
  "setup leaving $path dirty fails before worker creation",
  async ({ command, path, content }) => {
    const f = await preparationFixture(() => command);
    const failed = (await f.factory().tick("start", "T-owner")).runs.A;
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    expect(failed).toMatchObject({
      kind: "preparation-failed",
      reason: expect.stringContaining(path),
    });
    expect(failed).not.toHaveProperty("attempt");
    expect(await readFile(join(f.worktree, path), "utf8")).toBe(content);
    expect((await f.factory().tick("reconcile")).runs.A).toEqual(failed);
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  },
);

test("pre-existing non-worktree directory is preserved without setup or a worker", async () => {
  const f = await preparationFixture(
    (root) => `touch '${root}/.git/setup-started'; `,
  );
  await mkdir(f.worktree, { recursive: true });
  const note = join(f.worktree, "operator-note");
  await writeFile(note, "preserve this directory");
  const failed = (await f.factory().tick("start", "T-owner")).runs.A;
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  expect(failed).toMatchObject({ kind: "preparation-failed" });
  expect(failed).not.toHaveProperty("attempt");
  expect(await Bun.file(join(f.root, ".git/setup-started")).exists()).toBe(
    false,
  );
  expect(await readFile(note, "utf8")).toBe("preserve this directory");
  expect(
    (await f.factory().tick("retry-setup", "T-owner")).runs.A,
  ).toMatchObject({
    kind: "preparation-failed",
  });
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test.each([
  {
    command: "echo missing-dependencies >&2; exit 23",
    timeout: 60000,
    evidence: "missing-dependencies",
  },
  {
    command: "echo waiting-for-dependencies; sleep 5",
    timeout: 100,
    evidence: "timed out after 100ms",
  },
])(
  "failed setup retains $evidence and explicitly recovers at attempt one",
  async ({ command, timeout, evidence }) => {
    const f = await preparationFixture(
      (root) => `test -f '${root}/.git/release' || { ${command}; }; `,
      timeout,
    );
    const failed = (await f.factory().tick("start", "T-owner")).runs.A;
    if (failed?.kind !== "preparation-failed")
      throw new Error("Expected failed preparation");
    expect("attempt" in failed).toBe(false);
    expect(failed.pid).toBeUndefined();
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    const log = await readFile(failed.log, "utf8");
    expect(log).toContain(evidence);
    const reopened = f.factory();
    await Promise.all([
      reopened.tick("reconcile"),
      f.factory().tick("reconcile"),
    ]);
    expect((await reopened.tick("status")).runs.A).toEqual(failed);
    const configPath = join(f.root, ".factory.json");
    const config = await Bun.file(configPath).json();
    config.setup =
      "mkdir -p node_modules && printf prepared > node_modules/ready";
    config.setupTimeoutMs = 60000;
    await writeFile(configPath, JSON.stringify(config));
    expect(reopened.tick("retry-setup", "T-owner")).rejects.toThrow(
      "Commit existing changes",
    );
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    expect((await reopened.tick("status")).runs.A).toEqual(failed);
    f.git("add", ".factory.json");
    f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fix setup",
    );
    const base = f.git("rev-parse", "HEAD");
    const worktreeConfig = join(f.worktree, ".factory.json");
    const saved = await readFile(worktreeConfig, "utf8");
    await writeFile(worktreeConfig, `${saved}\n`);
    expect(reopened.tick("retry-setup", "T-owner")).rejects.toThrow(
      "Preparation worktree has local changes",
    );
    expect(await readFile(worktreeConfig, "utf8")).toBe(`${saved}\n`);
    expect((await reopened.tick("status")).runs.A).toEqual(failed);
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    await writeFile(worktreeConfig, saved);
    const retries = await Promise.allSettled([
      reopened.tick("retry-setup", "T-owner"),
      reopened.tick("retry-setup", "T-owner"),
      reopened.tick("reconcile"),
    ]);
    expect(retries[0]?.status).toBe("fulfilled");
    expect(retries[1]?.status).toBe("rejected");
    expect((await reopened.tick("status")).runs.A).toMatchObject({
      kind: "running",
      attempt: 1,
      base,
      worktree: failed.worktree,
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    expect(await readFile(failed.log, "utf8")).toBe(log);
    await mkdir(join(f.worktree, "src"));
    await writeFile(join(f.worktree, "src/value"), "good");
    f.git("-C", f.worktree, "add", "src/value");
    f.git(
      "-C",
      f.worktree,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "candidate",
    );
    const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
    await writeFile(
      join(reopened.directory, "A.report.json"),
      JSON.stringify({ kind: "candidate", attempt: 1, revision }),
    );
    f.host.state = async () => "idle";
    expect((await reopened.tick("reconcile")).runs.A).toMatchObject({
      kind: "done",
      revision,
    });
    expect(f.git("rev-parse", "HEAD")).toBe(revision);
    expect(await readFile(join(f.root, "src/value"), "utf8")).toBe("good");
  },
);

test("setup timeout releases inherited pipes from escaped descendants", async () => {
  const f = await preparationFixture(
    (root) =>
      `setsid bash -c 'echo $$ > ${root}/.git/escaped-pid; exec sleep 30' & `,
    500,
  );
  const starting = f.factory().tick("start", "T-owner");
  try {
    const result = await Promise.race([
      starting,
      Bun.sleep(3000).then(() => {
        throw new Error("Setup timeout did not release the coordinator");
      }),
    ]);
    expect(result.runs.A).toMatchObject({ kind: "preparation-failed" });
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  } finally {
    const pid = Number(
      await readFile(join(f.root, ".git/escaped-pid"), "utf8"),
    );
    process.kill(-pid, "SIGKILL");
    await starting;
  }
});

test("concurrent reconcile and explicit recovery cannot overlap live setup", async () => {
  const f = await preparationFixture(waitingSetup);
  const starting = f.factory().tick("start", "T-owner");
  await waitForFile(join(f.root, ".git/setup-running"));
  const reopened = f.factory();
  expect((await reopened.tick("reconcile")).runs.A?.kind).toBe("preparing");
  const retry = await reopened.tick("retry-setup", "T-owner").then(
    () => "overlapped",
    (error: unknown) => String(error),
  );
  expect(retry).toContain("still alive");
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  await writeFile(join(f.root, ".git/release"), "ready");
  expect((await starting).runs.A).toMatchObject({
    kind: "running",
    attempt: 1,
    worktree: f.worktree,
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("coordinator process death parks setup until explicit recovery in the same worktree", async () => {
  const f = await preparationFixture(waitingSetup);
  const runner = join(f.root, ".git/coordinator.ts");
  await writeFile(
    runner,
    `import {createFactory} from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
import {openStore} from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
await createFactory(${JSON.stringify(f.root)}, {
  async create() { throw new Error("Must not create before coordinator stops"); },
  async send() {}, async state() { return "running"; }, watch() {}
}, openStore).tick("start", "T-owner");`,
  );
  const child = spawn("bun", [runner], { stdio: "ignore" });
  await waitForFile(join(f.root, ".git/setup-running"));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  const factory = f.factory();
  const parked = (await factory.tick("reconcile")).runs.A;
  if (parked?.kind !== "preparing")
    throw new Error("Expected interrupted preparation");
  expect(await readFile(parked.log, "utf8")).toContain("setup-started");
  expect(factory.tick("retry-setup", "T-owner")).rejects.toThrow("still alive");
  await writeFile(join(f.root, ".git/release"), "ready");
  await waitForFile(join(f.worktree, "node_modules/ready"));
  const stopped = spawnSync("bash", [
    "-c",
    `for i in {1..200}; do kill -0 -- -${parked.pid} 2>/dev/null || exit 0; sleep 0.01; done; exit 1`,
  ]);
  expect(stopped.status).toBe(0);
  expect((await factory.tick("reconcile")).runs.A).toEqual(parked);
  expect((await factory.tick("retry-setup", "T-owner")).runs.A).toMatchObject({
    kind: "running",
    attempt: 1,
    worktree: f.worktree,
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("successful setup never retries ambiguous worker creation", async () => {
  const f = await preparationFixture(() => "");
  const create = f.host.create.bind(f.host);
  f.host.create = async (...args) => {
    await create(...args);
    throw new Error("lost creation response");
  };
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
    "lost creation response",
  );
  const reopened = f.factory();
  await reopened.tick("reconcile");
  await reopened.tick("retry-setup", "T-owner");
  expect((await reopened.tick("status")).runs.A).toMatchObject({
    kind: "creating",
    worktree: f.worktree,
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 0 });
});

test("setup preserves application files and disabled configuration across two repositories", async () => {
  const home = await mkdtemp(join(tmpdir(), "factory-install-"));
  try {
    for (const name of ["first", "second"]) {
      const root = join(home, name);
      await mkdir(join(root, "docs"), { recursive: true });
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "docs/prd.md"), "# Existing application\n");
      await writeFile(join(root, "AGENTS.md"), "Keep this guidance.\n");
      const args = [
        installer,
        "--repo",
        root,
        "--prd",
        "docs/prd.md",
        "--verify",
        "true",
        "--scope",
        "src/",
        "--store",
        resolve(import.meta.dir, "bookkeeping.fixture.ts"),
      ];
      const before = spawnSync("bun", [...args, "--check"], {
        encoding: "utf8",
      });
      expect(before.status).toBe(1);
      expect(await Bun.file(join(root, ".factory.json")).exists()).toBe(false);
      const install = spawnSync("bun", args, { encoding: "utf8" });
      expect(install.stderr).toBe("");
      expect(install.status).toBe(0);
      const configPath = join(root, ".factory.json");
      const config = await Bun.file(configPath).json();
      expect(config.workerModel).toBe("openai/gpt-6.1-sol");
      expect(config.workerEffort).toBe("medium");
      expect(config.permissions).toEqual({
        execute: false,
        publish: false,
        externalTickets: false,
      });
      expect(
        await Bun.file(join(root, ".amp/plugins/software-factory.js")).exists(),
      ).toBe(true);
      config.mode = "ui-polish";
      await writeFile(configPath, JSON.stringify(config));
      const preserved = await readFile(configPath, "utf8");
      expect(spawnSync("bun", args, { encoding: "utf8" }).status).toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(preserved);
      expect(
        spawnSync("bun", [...args, "--check"], { encoding: "utf8" }).status,
      ).toBe(0);
      expect(await readFile(join(root, "docs/prd.md"), "utf8")).toBe(
        "# Existing application\n",
      );
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
        "Keep this guidance.\n",
      );
      expect(
        await Bun.file(join(root, ".git/factory/state.json")).exists(),
      ).toBe(false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("unknown remote creation or delivery never starts replacement or independent workers", async () => {
  for (const failure of ["create", "send"]) {
    const root = await mkdtemp(join(tmpdir(), "factory-unknown-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      expect(
        spawnSync(
          "bun",
          [
            installer,
            "--repo",
            root,
            "--prd",
            "prd.md",
            "--verify",
            "true",
            "--scope",
            "src/",
            "--store",
            resolve(import.meta.dir, "bookkeeping.fixture.ts"),
          ],
          { encoding: "utf8" },
        ).status,
      ).toBe(0);
      const config = await Bun.file(join(root, ".factory.json")).json();
      config.permissions.execute = true;
      await writeFile(join(root, ".factory.json"), JSON.stringify(config));
      await writeFile(
        join(root, ".factory-tickets.json"),
        JSON.stringify([
          { id: "X", brief: "First", after: [] },
          { id: "Y", brief: "Independent", after: [] },
        ]),
      );
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      let creates = 0;
      let sends = 0;
      const host: NativeHost = {
        async create() {
          creates++;
          if (failure === "create") throw new Error("lost creation response");
          return "T-unknown";
        },
        async send(id) {
          if (id === "T-owner") return;
          sends++;
          throw new Error("lost delivery response");
        },
        async state() {
          return "running";
        },
        watch() {},
      };
      expect(
        createFactory(root, host, openStore).tick("start", "T-owner"),
      ).rejects.toThrow(/lost/);
      const reopened = createFactory(root, host, openStore);
      await reopened.tick("reconcile");
      await reopened.tick("reconcile");
      expect(creates).toBe(1);
      expect(sends).toBe(failure === "create" ? 0 : 1);
      expect((await reopened.tick("status")).runs.Y).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test.each(["high", undefined])(
  "native dispatch preserves effort %s, same-worker correction, and recovery",
  async (effort) => {
    const root = await mkdtemp(join(tmpdir(), "factory-dispatch-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Factory fixture");
      git("config", "user.email", "fixture@example.invalid");
      await mkdir(join(root, "src"));
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      await writeFile(join(root, "src/value"), "old");
      await writeFile(
        join(root, "check.cjs"),
        "if(require('fs').readFileSync('src/value','utf8') !== 'good') process.exit(1)",
      );
      expect(
        spawnSync(
          "bun",
          [
            installer,
            "--repo",
            root,
            "--prd",
            "prd.md",
            "--verify",
            "node check.cjs",
            "--scope",
            "src/",
            "--store",
            resolve(import.meta.dir, "bookkeeping.fixture.ts"),
          ],
          { encoding: "utf8" },
        ).status,
      ).toBe(0);
      const config = await Bun.file(join(root, ".factory.json")).json();
      config.permissions.execute = true;
      if (effort === undefined) delete config.workerEffort;
      else config.workerEffort = effort;
      await writeFile(join(root, ".factory.json"), JSON.stringify(config));
      const savedConfig = await readFile(join(root, ".factory.json"), "utf8");
      expect((await configuration(root)).workerEffort).toBe(effort);
      expect(await readFile(join(root, ".factory.json"), "utf8")).toBe(
        savedConfig,
      );
      await writeFile(
        join(root, ".factory-tickets.json"),
        JSON.stringify([
          { id: "A", brief: "Repair value", after: [] },
          { id: "B", brief: "Dependent", after: ["A"] },
          { id: "C", brief: "Independent", after: [] },
        ]),
      );
      git("add", ".");
      git("commit", "-qm", "fixture baseline");
      const messages: { id: string; text: string }[] = [];
      const notices: { id: string; text: string }[] = [];
      const settings: Parameters<NativeHost["create"]>[] = [];
      let created = 0;
      const host: NativeHost = {
        async create(...args) {
          settings.push(args);
          created++;
          return `T-fixture-${created}`;
        },
        async send(id, text) {
          (id === "T-owner" ? notices : messages).push({ id, text });
        },
        async state() {
          return "idle";
        },
        watch() {},
      };
      let factory = createFactory(root, host, openStore);
      await Promise.all([
        factory.tick("start", "T-owner"),
        factory.tick("reconcile"),
      ]);
      expect(
        (await readFile(join(factory.directory, "state.sqlite")))
          .subarray(0, 16)
          .toString(),
      ).toBe("SQLite format 3\u0000");
      expect(created).toBe(1);
      expect(settings).toEqual([["T-owner", "openai/gpt-6.1-sol", effort]]);
      const worktree = join(root, ".git/factory/worktrees/A");
      expect(await Bun.file(join(worktree, "src/value")).exists()).toBe(true);
      const candidate = async (
        value: string,
        attempt: number,
        insight = "",
      ) => {
        await writeFile(join(worktree, "src/value"), value);
        execFileSync("git", ["-C", worktree, "add", "src/value"]);
        execFileSync("git", [
          "-C",
          worktree,
          "commit",
          "-qm",
          `candidate ${attempt}`,
        ]);
        const revision = execFileSync(
          "git",
          ["-C", worktree, "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim();
        await writeFile(
          join(factory.directory, "A.report.json"),
          JSON.stringify({ kind: "candidate", attempt, revision, insight }),
        );
      };
      await candidate("bad", 1);
      await writeFile(
        join(root, ".factory.json"),
        JSON.stringify({ ...config, workerEffort: "max" }),
      );
      await factory.tick("reconcile");
      expect(created).toBe(1);
      expect(messages.map((message) => message.id)).toEqual([
        "T-fixture-1",
        "T-fixture-1",
      ]);
      await writeFile(join(root, ".factory.json"), savedConfig);
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
      await candidate("still bad", 2);
      await factory.tick("reconcile");
      expect(notices).toEqual([
        { id: "T-owner", text: expect.stringContaining("A") },
      ]);
      await factory.tick("pause");
      factory = createFactory(root, host, openStore);
      expect((await factory.tick("status")).runs.A?.kind).toBe("blocked");
      const repair = {
        ticket: "A",
        decision: "Correct the value contract, retaining this worker",
        incident: (await factory.tick("status")).runs.A!.incident!.id,
      };
      expect(
        factory.tick("resume", "T-fixture-1", host.state, repair),
      ).rejects.toThrow();
      expect(
        factory.tick("resume", "T-stranger", host.state, repair),
      ).rejects.toThrow();
      expect(
        factory.tick("resume", "T-owner", host.state, {
          ...repair,
          decision: "  ",
        }),
      ).rejects.toThrow(/nonempty/);
      await writeFile(join(worktree, "unexpected"), "setup dirt");
      expect(
        factory.tick("resume", "T-owner", host.state, repair),
      ).rejects.toThrow(/changed/);
      await rm(join(worktree, "unexpected"));
      await writeFile(join(root, "unexpected"), "integration dirt");
      expect(
        factory.tick("resume", "T-owner", host.state, repair),
      ).rejects.toThrow(/changed/);
      await rm(join(root, "unexpected"));
      const resumed = await Promise.allSettled([
        factory.tick("resume", "T-owner", host.state, repair),
        factory.tick("resume", "T-owner", host.state, repair),
      ]);
      expect(resumed.map((result) => result.status)).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect((await factory.tick("status")).enabled).toBe(false);
      expect(created).toBe(1);
      expect(messages).toHaveLength(2);
      host.state = async () => "unknown";
      expect(factory.tick("start", "T-owner")).rejects.toThrow(/idle/);
      host.state = async () => "idle";
      const base = git("rev-parse", "HEAD");
      git("commit", "--allow-empty", "-qm", "base changed while paused");
      expect(factory.tick("reconcile")).rejects.toThrow(/changed/);
      expect(messages).toHaveLength(2);
      git("reset", "--hard", base);
      await factory.tick("start", "T-owner");
      expect(messages[2]?.id).toBe("T-fixture-1");
      await candidate("almost good", 3);
      await writeFile(join(worktree, "src/value"), "unfinished edit");
      await writeFile(join(worktree, "unexpected"), "unfinished file");
      expect((await factory.tick("reconcile")).runs.A).toMatchObject({
        kind: "running",
        thread: "T-fixture-1",
        attempt: 4,
        delivery: "sent",
      });
      expect(messages[3]).toMatchObject({
        id: "T-fixture-1",
        text: expect.stringMatching(
          /Verification rejected attempt 3.*submit report attempt 4/,
        ),
      });
      expect(await readFile(join(worktree, "src/value"), "utf8")).toBe(
        "unfinished edit",
      );
      expect(await readFile(join(worktree, "unexpected"), "utf8")).toBe(
        "unfinished file",
      );
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
      expect(created).toBe(1);
      factory = createFactory(root, host, openStore);
      await factory.tick("reconcile");
      expect(messages).toHaveLength(4);
      await rm(join(worktree, "unexpected"));
      await candidate("good", 4, "Use the shared value contract");
      factory = createFactory(root, host, openStore);
      const state = await factory.tick("reconcile");
      expect(state.runs.A?.kind).toBe("done");
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("good");
      expect(created).toBe(2);
      expect(messages[4]?.text).toContain("Use the shared value contract");
      await writeFile(
        join(factory.directory, "B.report.json"),
        JSON.stringify({
          kind: "blocked",
          attempt: 1,
          reason: "Needs migration decision",
        }),
      );
      await factory.tick("reconcile");
      expect(created).toBe(3);
      expect(messages[5]?.text).not.toContain("Use the shared value contract");
      await Promise.all(
        Array.from({ length: 8 }, () => factory.tick("reconcile")),
      );
      expect(created).toBe(3);
      const db = new Database(join(factory.directory, "state.sqlite"), {
        readonly: true,
      });
      const events = db
        .query<{ ticket: string; action: string }, []>(
          "SELECT ticket, action FROM events",
        )
        .all();
      expect(
        db
          .query(
            "SELECT detail FROM events WHERE ticket = 'A' AND action = 'accepted'",
          )
          .all(),
      ).toEqual([{ detail: git("rev-parse", "HEAD") }]);
      db.close();
      expect(events.filter((event) => event.action === "creating")).toEqual([
        { ticket: "A", action: "creating" },
        { ticket: "B", action: "creating" },
        { ticket: "C", action: "creating" },
      ]);
      expect(
        events.filter(
          (event) => event.ticket === "B" && event.action === "blocked",
        ),
      ).toHaveLength(1);
      await factory.tick("pause");
      factory = createFactory(root, host, openStore);
      expect((await factory.tick("reconcile")).enabled).toBe(false);
      expect(created).toBe(3);
      expect(settings).toEqual(
        Array.from({ length: 3 }, () => [
          "T-owner",
          "openai/gpt-6.1-sol",
          effort,
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
