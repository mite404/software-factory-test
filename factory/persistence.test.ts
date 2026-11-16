import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactory, tasks, type NativeHost } from "./native";
import {
  factoryEvents,
  factoryRecords,
  factoryStatus,
  lifecycleStatus,
  openPersistence,
  type State,
} from "./persistence";

const roots: string[] = [];
const queue = [{ id: "A", brief: "Repair value", after: [] }];

test("lifecycle walking names every exitless stop and validates recoveries and persisted reasons", async () => {
  const table = lifecycleStatus();
  const actions = new Set([
    "retry-setup",
    "retry-create",
    "resume",
    "record-landing",
    "record-merge",
    "record-insight",
    "reload",
  ]);
  const observations = new Set([
    "setup-finished",
    "created",
    "accepted",
    "delivery-recovered",
    "review-recovered",
    "provider-continuation-sent",
    "provider-recovered",
    "review-fallback-creating",
    "blocked",
    "review-stopped",
    "stop-recorded",
  ]);
  const expectedExitless = [
    "blocked.withoutWorker",
    "running.reviewerCreation",
    "running.reviewerDeliveryLegacy",
    "running.workerDeliveryLegacy",
    "uncertain.legacy",
  ];
  const entries = Object.entries(table);
  const stops = entries.flatMap(([kind, entry]) =>
    Object.entries(entry.stops).map(([name, stop]) => ({
      id: `${kind}.${name}`,
      ...stop,
    })),
  );
  const exitless = stops.filter((stop) => !stop.exits.length);
  const exits = entries.flatMap(([kind, entry]) =>
    [
      ...entry.exits,
      ...Object.values(entry.stops).flatMap((stop) => stop.exits),
    ].map((exit) => ({ kind, admitted: entry.actions, ...exit })),
  );
  const directory = await mkdtemp(join(tmpdir(), "factory-lifecycle-walk-"));
  roots.push(directory);
  const storage = openPersistence(directory, queue);
  expect(Object.keys(table).sort()).toEqual([
    "blocked",
    "creating",
    "done",
    "parked",
    "preparation-failed",
    "preparing",
    "running",
    "uncertain",
  ]);
  try {
    expect(exitless.map((stop) => stop.id).sort()).toEqual(expectedExitless);
    expect(
      stops
        .filter((stop) => stop.foremanOnly)
        .map((stop) => stop.id)
        .sort(),
    ).toEqual(expectedExitless);
    expect(exitless.every((stop) => !!stop.foremanOnly?.trim())).toBe(true);
    expect([...new Set(stops.map((stop) => stop.recovery))].sort()).toEqual([
      "inspect",
      "resume",
      "retry-setup",
      "wait",
    ]);
    for (const [kind] of entries.filter(([kind]) => kind !== "done"))
      expect(
        exits.some((exit) => exit.kind === kind),
        kind,
      ).toBe(true);
    for (const exit of exits) {
      expect(exit.when.length).toBeGreaterThan(0);
      if ("action" in exit) {
        expect(actions.has(exit.action), exit.action).toBe(true);
        expect(exit.admitted).toContain(exit.action);
      } else expect(observations.has(exit.event), exit.event).toBe(true);
    }
    for (const stop of stops.filter((stop) => actions.has(stop.recovery)))
      expect(
        stop.exits.some(
          (exit) => "action" in exit && exit.action === stop.recovery,
        ),
        stop.id,
      ).toBe(true);
    for (const stop of stops) {
      for (const reason of stop.reasons) {
        const state: State = {
          enabled: false,
          owner: "T-owner",
          runs: {
            A: {
              kind: "blocked",
              reason: "Fixture",
              incident: {
                id: stop.id,
                owner: "T-owner",
                ticket: "A",
                base: "base",
                attempt: 1,
                reason,
                recovery: stop.recovery,
                delivery: "queued",
                ...(reason === "provider-limit"
                  ? {
                      providerLimit: {
                        thread: "T-worker" as const,
                        message: "Fixture limit",
                        observedAt: 1,
                      },
                    }
                  : {}),
              },
            },
          },
        };
        storage.commit(state, "A", "fixture", "");
        expect(factoryStatus(directory).runs.A.incident?.reason).toBe(reason);
      }
    }
  } finally {
    storage.close();
  }
});

test("event reads never initialize legacy storage or upgrade a version-one database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-event-reader-"));
  roots.push(directory);
  await writeFile(join(directory, "events.jsonl"), "legacy private text");
  expect(factoryEvents(directory)).toBeNull();
  expect(await readdir(directory)).toEqual(["events.jsonl"]);
  const path = join(directory, "state.sqlite");
  const db = new Database(path);
  db.run(
    "CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT, ticket TEXT, action TEXT, detail TEXT); PRAGMA user_version = 1;",
  );
  db.run(
    "INSERT INTO events VALUES (4, '2026-11-15T00:00:00Z', 'A', 'sent', 'T-worker')",
  );
  db.close();
  const before = await readFile(path);
  expect(factoryEvents(directory, 3, 1)).toEqual([
    {
      id: 4,
      at: "2026-11-15T00:00:00Z",
      ticket: "A",
      action: "sent",
      detail: "T-worker",
    },
  ]);
  for (const [after, limit] of [
    [-1, 1],
    [0, 0],
    [0, 501],
    [1.5, 1],
  ])
    expect(() => factoryEvents(directory, after, limit)).toThrow(
      "Invalid event bounds",
    );
  expect(await readFile(path)).toEqual(before);
});

const parked: State = {
  enabled: true,
  owner: "T-owner",
  runs: {
    A: {
      kind: "running",
      base: "abc",
      worktree: "/unused",
      thread: "T-original",
      attempt: 2,
      delivery: "sent",
    },
    B: { kind: "creating", base: "abc", worktree: "/unused-B" },
    C: { kind: "uncertain", thread: "T-ambiguous", reason: "Delivery unknown" },
    D: {
      kind: "done",
      thread: "T-accepted",
      revision: "def",
      insight: "Verified evidence",
    },
    E: {
      kind: "preparing",
      base: "abc",
      worktree: "/unused-E",
      command: "bun install --frozen-lockfile",
      timeoutMs: 120000,
      log: "/setup-E.log",
      pid: 12345,
    },
    F: {
      kind: "preparation-failed",
      base: "abc",
      worktree: "/unused-F",
      command: "false",
      timeoutMs: 1000,
      log: "/setup-F.log",
      reason: "Exit 1",
    },
  },
};

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

async function fixture(execute = true) {
  const root = await mkdtemp(join(tmpdir(), "factory-sqlite-"));
  roots.push(root);
  git(root, "init", "-q");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value"), "old");
  await writeFile(join(root, "prd.md"), "# Fixture\n");
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
      permissions: { execute, publish: false, externalTickets: false },
    }),
  );
  git(root, "add", ".");
  git(
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
  );
  let calls = 0;
  let locks = 0;
  const host: NativeHost = {
    async create() {
      calls++;
      return "T-original";
    },
    async send() {
      calls++;
    },
    async state() {
      return "unknown";
    },
    watch() {},
  };
  const factory = () =>
    createFactory(root, host, () => ({
      async init() {
        locks++;
      },
      async close() {},
      ledger: {
        async record() {
          calls++;
        },
      },
    }));
  return {
    root,
    directory: join(root, ".git/factory"),
    factory,
    calls: () => calls,
    locks: () => locks,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("parked repairs validate their original checkpoint and incident on save and reopen", async () => {
  const f = await fixture();
  const repair = {
    kind: "running" as const,
    base: "base",
    worktree: "/unused",
    thread: "T-original" as const,
    attempt: 4,
    delivery: "sent" as const,
  };
  const incident = {
    id: "park-1",
    ticket: "A",
    owner: "T-owner" as const,
    base: "base",
    attempt: 4,
    reason: "verification-rejected" as const,
    recovery: "resume" as const,
    delivery: "sent" as const,
  };
  const run = {
    kind: "parked" as const,
    thread: repair.thread,
    reason: "Cap reached",
    repair,
    incident,
  };
  const state: State = { enabled: true, owner: "T-owner", runs: { A: run } };
  const storage = openPersistence(f.directory, queue);
  try {
    storage.commit(state, "A", "parked", "Rejected fourth attempt");
    expect(factoryStatus(f.directory)).toEqual(state);
    for (const invalid of [
      { repair: undefined },
      { repair: { ...repair, attempt: 3 } },
      { repair: { ...repair, delivery: "queued" } },
      { repair: { ...repair, thread: "T-other" } },
      { checkpoint: repair },
      { incident: undefined },
      { incident: { ...incident, base: "other" } },
      { incident: { ...incident, attempt: 5 } },
      { incident: { ...incident, reason: "worker-blocked" } },
      { incident: { ...incident, recovery: "inspect" } },
    ]) {
      expect(() =>
        storage.commit(
          { ...state, runs: { A: { ...run, ...invalid } } } as unknown as State,
          "A",
          "invalid",
          "",
        ),
      ).toThrow();
      expect(factoryStatus(f.directory)).toEqual(state);
    }
  } finally {
    storage.close();
  }
  const before = await readFile(join(f.directory, "state.sqlite"));
  const reopened = openPersistence(f.directory, queue);
  expect(reopened.state).toEqual(state);
  reopened.close();
  expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(before);
});

test("delivery intents validate and reopen without adding keys to legacy runs", async () => {
  const f = await fixture();
  const storage = openPersistence(f.directory, queue);
  storage.commit(parked, "A", "fixture", "");
  storage.close();
  const before = await readFile(join(f.directory, "state.sqlite"));
  const reopened = openPersistence(f.directory, queue);
  expect(reopened.state).toEqual(parked);
  reopened.close();
  expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(before);
  const key = "b".repeat(64);
  const intent = {
    key,
    message: `factory-key: ${key}\nAssignment`,
    repeated: true,
  };
  const state = structuredClone(parked);
  const run = state.runs.A;
  if (run?.kind !== "running") throw new Error("Missing fixture worker");
  run.deliveryIntent = intent;
  const writer = openPersistence(f.directory, queue);
  try {
    writer.commit(state, "A", "fixture", "");
    for (const invalid of [
      null,
      { ...intent, key: "other" },
      { ...intent, message: "Missing marker" },
      { ...intent, repeated: "false" },
    ]) {
      const broken = {
        ...state,
        runs: { A: { ...run, deliveryIntent: invalid } },
      } as unknown as State;
      expect(() => writer.commit(broken, "A", "invalid", "")).toThrow();
      expect(factoryStatus(f.directory).runs.A).toEqual(run);
    }
  } finally {
    writer.close();
  }
  const confirmed = openPersistence(f.directory, queue);
  expect(confirmed.state.runs.A).toEqual(run);
  confirmed.close();
});

test("merge records validate on save and reopen without changing legacy runs", async () => {
  const f = await fixture();
  const storage = openPersistence(f.directory, queue);
  storage.commit(parked, "D", "fixture", "legacy");
  expect(factoryStatus(f.directory)).toEqual(parked);
  const merge = {
    pr: 42,
    commit: "a".repeat(40),
    at: "2026-11-15T12:34:56.000Z",
  };
  const state = structuredClone(parked);
  const done = state.runs.D! as Extract<
    State["runs"][string],
    { kind: "done" }
  >;
  done.merge = merge;
  storage.commit(state, "D", "merge-recorded", merge.commit);
  storage.close();
  const reopened = openPersistence(f.directory, queue);
  try {
    expect(reopened.state.runs.D).toEqual(done);
    for (const invalid of [
      { ...merge, pr: 0 },
      { ...merge, pr: 1.5 },
      { ...merge, pr: "42" },
      { ...merge, commit: "main" },
      { ...merge, at: "not a date" },
      { ...merge, url: "https://caller.invalid/private" },
      null,
    ]) {
      const broken = {
        ...state,
        runs: { D: { ...done, merge: invalid } },
      } as unknown as State;
      expect(() =>
        reopened.commit(broken, "D", "invalid", "private"),
      ).toThrow();
      expect(factoryStatus(f.directory).runs.D).toEqual(done);
    }
    expect(() =>
      reopened.commit(
        {
          ...state,
          runs: { A: { ...parked.runs.A, merge } },
        } as unknown as State,
        "A",
        "invalid",
        "private",
      ),
    ).toThrow();
  } finally {
    reopened.close();
  }
});

test("planning refresh cannot grant admission or rewrite admitted scope", async () => {
  const f = await fixture();
  const planned = {
    id: "A",
    brief: "Private scope",
    after: [],
    intake: "planned" as const,
    outcome: "Public outcome",
  };
  let storage = openPersistence(f.directory, [planned]);
  storage.close();
  const bytes = await readFile(join(f.directory, "state.sqlite"));
  storage = openPersistence(f.directory, [planned]);
  storage.close();
  expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(bytes);
  storage = openPersistence(f.directory, [
    { id: "A", brief: "Refreshed scope", after: [] },
  ]);
  expect(storage.tickets[0]).toMatchObject({
    intake: "planned",
    outcome: "Public outcome",
    brief: "Refreshed scope",
  });
  storage.admit("A");
  storage.close();
  storage = openPersistence(f.directory, [
    { ...planned, brief: "Unauthorized scope replacement" },
  ]);
  expect(storage.tickets[0]).toMatchObject({
    intake: "admitted",
    brief: "Refreshed scope",
  });
  storage.close();
  expect(() =>
    openPersistence(f.directory, [{ ...planned, intake: "admitted" }]),
  ).toThrow("cannot grant admission");
  expect(factoryRecords(f.directory)?.tickets).toEqual([
    { id: "A", steps: [], intake: "admitted", outcome: "Public outcome" },
  ]);
});

test("status reads fresh and legacy repositories without runtime writes or locks", async () => {
  const f = await fixture();
  expect(await f.factory().tick("status")).toEqual({
    enabled: false,
    runs: {},
  });
  expect(existsSync(f.directory)).toBe(false);
  await mkdir(f.directory);
  const original = JSON.stringify(parked);
  await writeFile(join(f.directory, "state.json"), original);
  expect(await f.factory().tick("status")).toEqual(parked);
  expect(await readdir(f.directory)).toEqual(["state.json"]);
  expect(await readFile(join(f.directory, "state.json"), "utf8")).toBe(
    original,
  );
  expect(f.locks()).toBe(0);
  expect(f.calls()).toBe(0);
});

test("durable records retain ticket identity without importing legacy or writing SQLite", async () => {
  const f = await fixture();
  expect(factoryRecords(f.directory)).toBeNull();
  expect(existsSync(f.directory)).toBe(false);
  await mkdir(f.directory);
  await writeFile(join(f.directory, "state.json"), JSON.stringify(parked));
  expect(factoryRecords(f.directory)).toBeNull();
  expect(await readdir(f.directory)).toEqual(["state.json"]);
  const storage = openPersistence(f.directory, queue);
  storage.close();
  const old = new Database(join(f.directory, "state.sqlite"));
  old.run(
    "DROP TABLE definitions; DROP TABLE loaded_definition; PRAGMA user_version = 1",
  );
  old.close();
  const legacyBytes = await readFile(join(f.directory, "state.sqlite"));
  expect(factoryStatus(f.directory)).toEqual(parked);
  expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(
    legacyBytes,
  );
  const reopened = openPersistence(f.directory, []);
  reopened.close();
  await writeFile(join(f.directory, "state.json"), "invalid legacy");
  const bytes = await readFile(join(f.directory, "state.sqlite"));
  const files = await readdir(f.directory);
  const unchanged = openPersistence(f.directory, tasks(queue));
  unchanged.close();
  const db = new Database(join(f.directory, "state.sqlite"), {
    readonly: true,
  });
  try {
    expect(
      db
        .query(
          "SELECT count(*) AS count FROM events WHERE action = 'configured'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db.query("SELECT id, data FROM tickets ORDER BY rowid").all(),
    ).toEqual([{ id: "A", data: JSON.stringify(queue[0]) }]);
  } finally {
    db.close();
  }
  expect(factoryRecords(f.directory)).toEqual({
    state: parked,
    tickets: [{ id: "A", steps: [] }],
  });
  expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(bytes);
  expect(await readdir(f.directory)).toEqual(files);
  expect(f.locks()).toBe(0);
  expect(f.calls()).toBe(0);
});

test("migration preserves nonempty ownership and history exactly once across restarts", async () => {
  const f = await fixture();
  await mkdir(f.directory);
  const original = JSON.stringify(parked);
  const history =
    '{"at":"2026-01-02T03:04:05Z","ticket":"D","action":"accepted","detail":"def"}\n';
  await writeFile(join(f.directory, "state.json"), original);
  await writeFile(join(f.directory, "events.jsonl"), history);
  const recovered = await f.factory().tick("reconcile");
  expect(recovered).toMatchObject(parked);
  expect(recovered.runs.B!.incident).toMatchObject({
    reason: "creation-unknown",
    recovery: "inspect",
    owner: "T-owner",
    delivery: "sent",
  });
  expect(recovered.runs.C!.incident).toMatchObject({
    reason: "delivery-unknown",
    recovery: "inspect",
  });
  expect(recovered.runs.E!.incident).toMatchObject({
    reason: "preparation-interrupted",
    recovery: "retry-setup",
  });
  expect(recovered.runs.F!.incident).toMatchObject({
    reason: "preparation-failed",
    recovery: "retry-setup",
  });
  for (let i = 0; i < 2; i++)
    expect(await f.factory().tick("reconcile")).toEqual(recovered);
  expect(f.calls()).toBe(4);
  const db = new Database(join(f.directory, "state.sqlite"));
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(
    db
      .query(
        "SELECT at, ticket, action, detail FROM events WHERE action = 'accepted'",
      )
      .all(),
  ).toEqual([
    {
      at: "2026-01-02T03:04:05Z",
      ticket: "D",
      action: "accepted",
      detail: "def",
    },
  ]);
  expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 6 });
  expect(db.query("SELECT id FROM tickets").all()).toEqual([{ id: "A" }]);
  db.close();
  await f.factory().tick("pause");
  expect((await f.factory().tick("reconcile")).enabled).toBe(false);
  expect(await readFile(join(f.directory, "state.json"), "utf8")).toBe(
    original,
  );
  expect(await readFile(join(f.directory, "events.jsonl"), "utf8")).toBe(
    history,
  );
  await writeFile(join(f.directory, "state.json"), "stale invalid legacy");
  const files = await readdir(f.directory);
  const bytes = await readFile(join(f.directory, "state.sqlite"));
  expect((await f.factory().tick("status")).runs).toEqual(recovered.runs);
  expect(await readdir(f.directory)).toEqual(files);
  expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(bytes);
});

test("a failed transition rolls back ownership and history before any worker call", async () => {
  const f = await fixture();
  await f.factory().tick("pause");
  const db = new Database(join(f.directory, "state.sqlite"));
  db.run(`CREATE TRIGGER fail_claim BEFORE INSERT ON events WHEN NEW.action = 'creating'
    BEGIN SELECT RAISE(ABORT, 'forced transaction failure'); END`);
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
    "forced transaction failure",
  );
  expect(await f.factory().tick("status")).toEqual({
    enabled: true,
    owner: "T-owner",
    runs: {},
  });
  expect(db.query("SELECT action FROM events ORDER BY id").all()).toEqual([
    { action: "configured" },
    { action: "paused" },
    { action: "started" },
  ]);
  expect(f.calls()).toBe(0);
  db.run("DROP TRIGGER fail_claim");
  db.close();
  expect((await f.factory().tick("reconcile")).runs.A).toMatchObject({
    kind: "running",
    thread: "T-original",
    attempt: 1,
    delivery: "sent",
  });
  expect(f.calls()).toBe(2);
});

test.each([
  "{",
  "null",
  '{"enabled":true,"runs":[]}',
  '{"enabled":true,"runs":{"A":null}}',
  '{"enabled":true,"runs":{"A":{"kind":"running","thread":"T-original"}}}',
  '{"enabled":true,"runs":{"A":{"kind":"unrecognized"}}}',
  ...[
    { ...parked.runs.E, log: "" },
    { ...parked.runs.E, timeoutMs: 0 },
    { ...parked.runs.E, pid: -1 },
    { ...parked.runs.E, attempt: 1 },
    { ...parked.runs.E, thread: "T-premature" },
    { ...parked.runs.F, reason: "" },
    { ...parked.runs.F, incident: null },
    {
      ...parked.runs.F,
      incident: {
        id: "stop",
        ticket: "B",
        owner: "T-owner",
        base: "abc",
        attempt: 0,
        reason: "preparation-failed",
        recovery: "retry-setup",
        delivery: "queued",
      },
    },
  ].map((run) => JSON.stringify({ enabled: true, runs: { A: run } })),
])(
  "invalid legacy state fails closed without overwriting bytes %s",
  async (bytes) => {
    const f = await fixture();
    await mkdir(f.directory);
    await writeFile(join(f.directory, "state.json"), bytes);
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow();
    expect(f.calls()).toBe(0);
    expect(existsSync(join(f.directory, "state.sqlite"))).toBe(false);
    expect(await readFile(join(f.directory, "state.json"), "utf8")).toBe(bytes);
  },
);

test.each([
  "{\n",
  "{}\n",
  '{"at":"yesterday","ticket":"A","action":"sent","detail":"T-original"}\n',
])("invalid event history fails before dispatch %s", async (bytes) => {
  const f = await fixture();
  await mkdir(f.directory);
  await writeFile(join(f.directory, "events.jsonl"), bytes);
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow();
  expect(f.calls()).toBe(0);
  expect(existsSync(join(f.directory, "state.sqlite"))).toBe(false);
  expect(await readFile(join(f.directory, "events.jsonl"), "utf8")).toBe(bytes);
});

test.each(["corrupt", "newer", "unversioned"])(
  "%s SQLite fails closed and preserves the file",
  async (kind) => {
    const f = await fixture();
    await mkdir(f.directory);
    const path = join(f.directory, "state.sqlite");
    if (kind === "corrupt") await writeFile(path, "not a SQLite database");
    else {
      const db = new Database(path, { create: true });
      db.run(`PRAGMA user_version = ${kind === "newer" ? 3 : 0}`);
      db.close();
    }
    const bytes = await readFile(path);
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow();
    expect(f.factory().tick("status")).rejects.toThrow();
    expect(() => factoryRecords(f.directory)).toThrow();
    expect(await readFile(path)).toEqual(bytes);
    expect(f.calls()).toBe(0);
  },
);

test("manifest removal retains the original worker and its delivery recovery", async () => {
  const f = await fixture();
  const original = (await f.factory().tick("start", "T-owner")).runs.A;
  expect(original).toMatchObject({
    kind: "running",
    thread: "T-original",
    delivery: "sent",
  });
  await writeFile(join(f.root, "tickets.json"), "[]");
  expect((await f.factory().tick("reconcile")).runs.A).toEqual(original);
  const storage = openPersistence(f.directory, []);
  if (storage.state.runs.A?.kind !== "running")
    throw new Error("Missing original run");
  storage.state.runs.A.delivery = "sending";
  storage.commit(storage.state, "A", "sending", "T-original");
  storage.close();
  const expected = {
    kind: "uncertain",
    definition: original?.definition,
    thread: "T-original",
    reason: "Delivery outcome unknown; inspect thread before recovery",
  } as const;
  const uncertain = (await f.factory().tick("reconcile")).runs.A;
  expect(uncertain).toMatchObject(expected);
  expect(uncertain!.incident).toMatchObject({
    reason: "delivery-unknown",
    recovery: "inspect",
    attempt: 1,
  });
  expect((await f.factory().tick("reconcile")).runs.A).toEqual(uncertain);
  expect(f.calls()).toBe(3);
});

test("disabled execution remains disabled through initialization and reopening", async () => {
  const f = await fixture(false);
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
    "permissions.execute",
  );
  expect(await f.factory().tick("reconcile")).toEqual({
    enabled: false,
    runs: {},
  });
  expect(factoryStatus(f.directory)).toEqual({ enabled: false, runs: {} });
  expect(f.calls()).toBe(0);
});

test.each(["queued", "sending", "sent"] as const)(
  "legacy %s delivery retains the original attempt and worker",
  async (delivery) => {
    const f = await fixture();
    await mkdir(f.directory);
    const run = {
      kind: "running",
      base: "abc",
      worktree: "/unused",
      thread: "T-original",
      attempt: 2,
      delivery,
    } as const;
    await writeFile(
      join(f.directory, "state.json"),
      JSON.stringify({
        enabled: true,
        owner: "T-owner",
        runs: { A: run },
      }),
    );
    const result = await f.factory().tick("reconcile");
    if (delivery === "sending") {
      expect(result.runs.A).toMatchObject({
        kind: "uncertain",
        thread: "T-original",
        reason: "Delivery outcome unknown; inspect thread before recovery",
        incident: {
          reason: "delivery-unknown",
          recovery: "inspect",
          attempt: 2,
          base: "abc",
        },
      });
    } else {
      expect(result.runs.A).toMatchObject({
        ...run,
        delivery: "sent",
        watchdog: { attempt: 2, alerts: [] },
      });
      expect(result.runs.A!.incident).toBeUndefined();
    }
    expect((await f.factory().tick("reconcile")).runs.A).toEqual(result.runs.A);
    expect(f.calls()).toBe(delivery === "sent" ? 0 : 1);
  },
);

test("legacy accepted work is not reintegrated after migration or repeated reopening", async () => {
  const f = await fixture();
  await mkdir(f.directory);
  const accepted = {
    kind: "done",
    thread: "T-accepted",
    revision: "def",
    insight: "Verified",
  } as const;
  await writeFile(
    join(f.directory, "state.json"),
    JSON.stringify({
      enabled: true,
      owner: "T-owner",
      runs: { A: accepted },
    }),
  );
  for (let i = 0; i < 3; i++)
    expect((await f.factory().tick("reconcile")).runs.A).toEqual(accepted);
  expect(f.calls()).toBe(0);
});
