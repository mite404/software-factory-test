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
import { createFactory, type NativeHost } from "./native";
import {
  factoryRecords,
  factoryStatus,
  openPersistence,
  type State,
} from "./persistence";

const roots: string[] = [];
const queue = [{ id: "A", brief: "Repair value", after: [] }];
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
  const reopened = openPersistence(f.directory, []);
  reopened.close();
  await writeFile(join(f.directory, "state.json"), "invalid legacy");
  const bytes = await readFile(join(f.directory, "state.sqlite"));
  const files = await readdir(f.directory);
  expect(factoryRecords(f.directory)).toEqual({
    state: parked,
    tickets: ["A"],
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
  expect(await f.factory().tick("reconcile")).toEqual(parked);
  for (let i = 0; i < 2; i++)
    expect(await f.factory().tick("reconcile")).toEqual(parked);
  expect(f.calls()).toBe(0);
  const db = new Database(join(f.directory, "state.sqlite"));
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
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
  expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 4 });
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
  expect((await f.factory().tick("status")).runs).toEqual(parked.runs);
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
      db.run(`PRAGMA user_version = ${kind === "newer" ? 2 : 0}`);
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
    thread: "T-original",
    reason: "Delivery outcome unknown; inspect thread before recovery",
  } as const;
  expect((await f.factory().tick("reconcile")).runs.A).toEqual(expected);
  expect((await f.factory().tick("reconcile")).runs.A).toEqual(expected);
  expect(f.calls()).toBe(2);
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
      expect(result.runs.A).toEqual({
        kind: "uncertain",
        thread: "T-original",
        reason: "Delivery outcome unknown; inspect thread before recovery",
      });
    } else expect(result.runs.A).toEqual({ ...run, delivery: "sent" });
    expect((await f.factory().tick("reconcile")).runs.A).toEqual(result.runs.A);
    expect(f.calls()).toBe(delivery === "queued" ? 1 : 0);
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
