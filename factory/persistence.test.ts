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
import { pipelineSteps } from "./pipeline";
import {
  admitsRun,
  factoryEvidence,
  factoryEvents,
  factoryRecords,
  factoryStatus,
  lifecycleStatus,
  openPersistence,
  publicSummary,
  runStage,
  stages,
  type Run,
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
  const actors = new Set(["computer", "model", "foreman", "operator"]);
  [
    ...entries.map(([, entry]) => entry),
    ...stops,
    ...exits,
    ...pipelineSteps,
  ].forEach((entry) => {
    expect(actors.has(entry.actor), JSON.stringify(entry)).toBe(true);
  });
  entries.forEach(([, entry]) => {
    entry.actions.forEach((action) => {
      expect(
        [
          ...entry.exits,
          ...Object.values(entry.stops).flatMap((stop) => stop.exits),
        ].some((exit) => "action" in exit && exit.action === action),
        action,
      ).toBe(true);
    });
  });
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

test("evidence commits converge on repeats and refuse invalid or conflicting provenance with their transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-evidence-"));
  roots.push(directory);
  expect(factoryEvidence(directory, "A")).toBeNull();
  expect(await readdir(directory)).toEqual([]);
  const storage = openPersistence(directory, queue);
  try {
    const { state } = storage;
    const gate = {
      attempt: 1,
      kind: "gate",
      revision: "a".repeat(40),
      definition: null,
      tool: "bun test",
      outcome: "gate-passed",
      content: "log one",
    } as const;
    storage.commit(state, "A", "accepted", "first", [gate]);
    storage.commit(state, "A", "accepted", "repeat", [gate]);
    const rerun = { ...gate, outcome: "gate-failed", content: "log two!" };
    storage.commit(state, "A", "rejected", "rerun", [rerun]);
    const recorded = () =>
      factoryEvidence(directory, "A")!.map(
        ({ outcome, bytes, intact, at: _at, sha256: _sha, ...row }) => ({
          ...row,
          outcome,
          bytes,
          intact,
        }),
      );
    const row = {
      ticket: "A",
      attempt: 1,
      kind: "gate" as const,
      revision: "a".repeat(40),
      definition: null,
      tool: "bun test",
      intact: true,
    };
    const expected = [
      { ...row, outcome: "gate-passed", bytes: 7 },
      { ...row, outcome: "gate-failed", bytes: 8 },
    ];
    expect(recorded()).toEqual(expected);
    const events = factoryEvents(directory, 0, 500);
    for (const invalid of [
      { ...gate, tool: "another check" },
      { ...gate, definition: "b".repeat(64) },
      { ...gate, revision: "HEAD" },
      { ...gate, outcome: "pass" },
      { ...gate, kind: "review" },
      { ...gate, attempt: 0 },
      { ...gate, tool: "" },
    ])
      expect(() =>
        storage.commit(state, "A", "accepted", "refused", [
          invalid as typeof gate,
        ]),
      ).toThrow();
    expect(factoryEvents(directory, 0, 500)).toEqual(events);
    expect(recorded()).toEqual(expected);
    expect(factoryEvidence(directory, "unknown")).toBeUndefined();
  } finally {
    storage.close();
  }
});

test("retry-create admits a running run only while its reviewer creation is the held stop", () => {
  const sha = "a".repeat(40);
  const incident = (reason: string) => ({
    incident: { id: "I", reason } as NonNullable<Run["incident"]>,
  });
  const running = (delivery?: string) =>
    ({
      kind: "running",
      base: sha,
      worktree: "/w",
      thread: "T-worker",
      attempt: 1,
      delivery: "sent",
      ...(delivery ? { review: { delivery } } : {}),
    }) as Run;
  const cases: [string, Run, boolean][] = [
    [
      "reviewer creation",
      { ...running("creating"), ...incident("creation-unknown") },
      true,
    ],
    ["reviewer creating before any incident", running("creating"), false],
    [
      "reviewer sent",
      { ...running("sent"), ...incident("creation-unknown") },
      false,
    ],
    [
      "reviewer delivery",
      { ...running("sending"), ...incident("delivery-unknown") },
      false,
    ],
    [
      "reviewer creating at a limit",
      { ...running("creating"), ...incident("provider-limit") },
      false,
    ],
    [
      "worker without review",
      { ...running(), ...incident("creation-unknown") },
      false,
    ],
    [
      "worker creation",
      {
        kind: "creating",
        base: sha,
        worktree: "/w",
        ...incident("creation-unknown"),
      },
      true,
    ],
    [
      "worker creation before any incident",
      { kind: "creating", base: sha, worktree: "/w" },
      true,
    ],
  ];
  for (const [name, run, admitted] of cases)
    expect(admitsRun(run, "retry-create"), name).toBe(admitted);
  expect(
    admitsRun(
      { kind: "blocked", reason: "x", ...incident("worker-blocked") },
      "resume",
    ),
  ).toBe(true);
});

test("every run kind and stop reason names exactly one declared stage and actor", () => {
  const sha = "a".repeat(40);
  const worker = {
    kind: "running",
    base: sha,
    worktree: "/w",
    thread: "T-worker",
    attempt: 2,
    delivery: "sent",
  } as const;
  const review = { thread: "T-reviewer", delivery: "sent" } as never;
  const incident = (reason: string, extra = {}) => ({
    incident: { reason, ...extra } as NonNullable<Run["incident"]>,
  });
  const prep = {
    base: sha,
    worktree: "/w",
    command: "x",
    timeoutMs: 1,
    log: "l",
  };
  const cases: [string, Run | undefined, string, string | null][] = [
    ["no run", undefined, "queued", "computer"],
    ["preparing", { kind: "preparing", ...prep }, "preparing", "computer"],
    [
      "interrupted setup",
      { kind: "preparing", ...prep, ...incident("preparation-interrupted") },
      "preparing",
      "foreman",
    ],
    [
      "failed setup",
      {
        kind: "preparation-failed",
        reason: "x",
        ...prep,
        ...incident("preparation-failed"),
      },
      "blocked",
      "foreman",
    ],
    [
      "creating",
      { kind: "creating", base: sha, worktree: "/w" },
      "creating",
      "computer",
    ],
    [
      "ambiguous creation",
      {
        kind: "creating",
        base: sha,
        worktree: "/w",
        ...incident("creation-unknown"),
      },
      "creating",
      "foreman",
    ],
    ["worker writing", worker, "building", "model"],
    [
      "gate running",
      { ...worker, gate: { at: 1, pid: 1 } },
      "gating",
      "computer",
    ],
    ["cold review", { ...worker, review }, "reviewing", "model"],
    [
      "reviewer awaiting approval",
      { ...worker, review, ...incident("approval-required") },
      "reviewing",
      "operator",
    ],
    [
      "provider limit",
      {
        ...worker,
        ...incident("provider-limit", { providerLimit: { resetAt: 9000 } }),
      },
      "rate-limited",
      "computer",
    ],
    [
      "two rejections",
      {
        kind: "blocked",
        reason: "x",
        thread: "T-worker",
        repair: worker,
        ...incident("verification-rejected"),
      },
      "escalated",
      "foreman",
    ],
    [
      "worker blocked",
      {
        kind: "blocked",
        reason: "x",
        thread: "T-worker",
        checkpoint: worker,
        ...incident("worker-blocked"),
      },
      "blocked",
      "foreman",
    ],
    [
      "four rejections",
      {
        kind: "parked",
        reason: "x",
        thread: "T-worker",
        repair: { ...worker, attempt: 4 },
        ...incident("verification-rejected"),
      },
      "parked",
      "operator",
    ],
    [
      "keyed unknown delivery",
      {
        kind: "uncertain",
        reason: "x",
        thread: "T-worker",
        checkpoint: { ...worker, deliveryIntent: {} } as never,
        ...incident("delivery-unknown"),
      },
      "uncertain",
      "computer",
    ],
    [
      "legacy unknown delivery",
      {
        kind: "uncertain",
        reason: "x",
        thread: "T-worker",
        ...incident("delivery-unknown"),
      },
      "uncertain",
      "foreman",
    ],
    [
      "accepted",
      { kind: "done", revision: sha, thread: "T-worker", insight: "" },
      "accepted",
      "foreman",
    ],
    [
      "merged",
      {
        kind: "done",
        revision: sha,
        thread: "T-worker",
        insight: "",
        merge: { pr: 1, commit: sha, at: "2026-11-17T00:00:00Z" },
      },
      "merged",
      null,
    ],
  ];
  for (const [name, run, stage, actor] of cases)
    expect([name, runStage(run).stage, runStage(run).actor]).toEqual([
      name,
      stage,
      actor,
    ]);
  expect(runStage(undefined, "planned")).toMatchObject({
    stage: "planned",
    actor: "foreman",
    status: "planned",
  });
  expect(runStage(cases[10]![1]).clearsAt).toBe(9000);
  expect(runStage(cases[7]![1]).clearsAt).toBeNull();
  // Public statuses keep their pre-stage meaning: one per kind, unknown until observed.
  expect(cases.map(([, run]) => runStage(run).status)).toEqual([
    "queued",
    "unknown",
    "unknown",
    "blocked",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "blocked",
    "blocked",
    "blocked",
    "blocked",
    "blocked",
    "accepted",
    "accepted",
  ]);
  const ids = stages.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  const reasons = [
    ...new Set(
      Object.values(lifecycleStatus()).flatMap((entry) =>
        Object.values(entry.stops).flatMap((stop) => stop.reasons),
      ),
    ),
  ];
  for (const [, run] of cases)
    for (const reason of [undefined, ...reasons]) {
      const named = runStage(
        run && (reason ? { ...run, ...incident(reason) } : run),
      );
      expect(ids.filter((id) => id === named.stage)).toHaveLength(1);
      expect([null, "computer", "model", "foreman", "operator"]).toContain(
        named.actor,
      );
      // The graph places a run by these two keys, so both must name the table's own entries.
      expect(named.kind).toBe(run?.kind ?? null);
      if (named.stopName)
        expect(Object.keys(lifecycleStatus()[run!.kind]!.stops)).toContain(
          named.stopName,
        );
    }
  const stopNames = cases.map(([, run]) => runStage(run).stopName);
  // Only runs holding an incident name a stop; the rest sit on their kind.
  expect(stopNames).toEqual([
    null, // no run
    null, // preparing
    "interrupted",
    "failed",
    null, // creating
    "unknown",
    null, // worker writing
    null, // gate running
    null, // cold review
    "reviewerApproval",
    "providerLimit",
    "repair",
    "checkpoint",
    "repair",
    "keyed",
    "legacy",
    null, // accepted
    null, // merged
  ]);
});

test("acceptance summaries publish one bounded line and refuse private shapes", () => {
  expect(publicSummary("  Names every\n run's  stage ")).toEqual({
    summary: "Names every run's stage",
  });
  const long = publicSummary("word ".repeat(40)).summary!;
  expect(long).toHaveLength(120);
  expect(long.endsWith("…")).toBe(true);
  for (const value of [
    "See /home/user/report.json",
    "Read C:\\reports",
    "Thread T-01a1-worker has it",
    "https://example.invalid",
    "bell\u0007",
    "   ",
    42,
    undefined,
  ])
    expect(publicSummary(value)).toEqual({});
});

test("state saved before stages opens unchanged and maps to a stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-stage-legacy-"));
  roots.push(directory);
  openPersistence(directory, queue).close();
  const saved = {
    kind: "running",
    base: "base",
    worktree: "/w",
    thread: "T-worker",
    attempt: 1,
    delivery: "sent",
  };
  const db = new Database(join(directory, "state.sqlite"));
  db.query("INSERT INTO runs (ticket, data) VALUES ('A', ?)").run(
    JSON.stringify(saved),
  );
  db.close();
  const before = await readFile(join(directory, "state.sqlite"));
  const run = factoryStatus(directory).runs.A;
  expect(run).toEqual(saved as Run);
  expect(runStage(run)).toMatchObject({
    stage: "building",
    status: "unknown",
    since: null,
  });
  expect(await readFile(join(directory, "state.sqlite"))).toEqual(before);
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

test("sync sweeps only runless unadmitted synced rows and records each removal", async () => {
  const f = await fixture();
  const synced = {
    id: "F100-vanished",
    brief: "Implement docs/feats/x/F100-vanished.md",
    after: [],
    intake: "planned" as const,
    outcome: "Public outcome",
    steps: ["Read files"],
    file: "docs/feats/x/F100-vanished.md",
  };
  const admitted = {
    ...synced,
    id: "F101-admitted",
    file: "docs/feats/x/F101-admitted.md",
  };
  const running = {
    ...synced,
    id: "F102-running",
    file: "docs/feats/x/F102-running.md",
  };
  let storage = openPersistence(
    f.directory,
    [...queue, synced, admitted, running],
    undefined,
    { skipped: [] },
  );
  storage.admit("F101-admitted");
  storage.commit(
    {
      enabled: false,
      runs: {
        "F102-running": { kind: "creating", base: "abc", worktree: "/w" },
      },
    },
    "F102-running",
    "creating",
    "fixture",
  );
  storage.close();
  const admittedRow = () => {
    const db = new Database(join(f.directory, "state.sqlite"), {
      readonly: true,
    });
    try {
      return db
        .query<{ data: string }, []>(
          "SELECT data FROM tickets WHERE id = 'F101-admitted'",
        )
        .get()!.data;
    } finally {
      db.close();
    }
  };
  const frozen = admittedRow();
  // A sync whose files are all gone, with the admitted row's fields changed.
  storage = openPersistence(
    f.directory,
    [...queue, { ...admitted, outcome: "Changed outcome", steps: ["New"] }],
    undefined,
    { skipped: [] },
  );
  expect(storage.tickets.map((task) => task.id).sort()).toEqual([
    "A",
    "F101-admitted",
    "F102-running",
  ]);
  storage.close();
  expect(admittedRow()).toBe(frozen);
  expect(
    factoryEvents(f.directory, 0, 500)!.filter(
      (event) => event.action === "removed",
    ),
  ).toEqual([
    expect.objectContaining({
      ticket: "F100-vanished",
      detail: "docs/feats/x/F100-vanished.md",
    }),
  ]);
  // Without the sync argument nothing is swept, even with an empty queue.
  storage = openPersistence(f.directory, []);
  expect(storage.tickets.map((task) => task.id).sort()).toEqual([
    "A",
    "F101-admitted",
    "F102-running",
  ]);
  storage.close();
});

test("skipped ticket list persists in status and an unchanged sync writes no event", async () => {
  const f = await fixture();
  const skippedEvents = () =>
    factoryEvents(f.directory, 0, 500)!.filter(
      (event) => event.action === "tickets-skipped",
    );
  // A first sync with nothing skipped writes no row and no event.
  let storage = openPersistence(f.directory, queue, undefined, {
    skipped: [],
  });
  storage.close();
  expect(factoryStatus(f.directory).skippedTickets).toBeUndefined();
  expect(skippedEvents()).toHaveLength(0);
  const skipped = [
    {
      file: "docs/feats/x/F103-broken.md",
      reason: "no Outcome line under ## Status",
    },
  ];
  storage = openPersistence(f.directory, queue, undefined, { skipped });
  storage.close();
  expect(factoryStatus(f.directory).skippedTickets).toEqual(skipped);
  expect(skippedEvents()).toHaveLength(1);
  const events = factoryEvents(f.directory, 0, 500);
  storage = openPersistence(f.directory, queue, undefined, { skipped });
  storage.close();
  expect(factoryEvents(f.directory, 0, 500)).toEqual(events);
  storage = openPersistence(f.directory, queue, undefined, { skipped: [] });
  storage.close();
  expect(factoryStatus(f.directory).skippedTickets).toEqual([]);
  expect(skippedEvents()).toHaveLength(2);
});

test("removing the ticketFiles setting clears the stale skip list once", async () => {
  const f = await fixture();
  const skipped = [
    {
      file: "docs/feats/x/F103-broken.md",
      reason: "no Outcome line under ## Status",
    },
  ];
  let storage = openPersistence(f.directory, queue, undefined, { skipped });
  storage.close();
  expect(factoryStatus(f.directory).skippedTickets).toEqual(skipped);
  // A reload with the setting gone clears the list once, then stays quiet.
  storage = openPersistence(f.directory, queue, undefined, "off");
  storage.close();
  expect(factoryStatus(f.directory).skippedTickets).toEqual([]);
  const events = factoryEvents(f.directory, 0, 500);
  storage = openPersistence(f.directory, queue, undefined, "off");
  storage.close();
  expect(factoryEvents(f.directory, 0, 500)).toEqual(events);
  // Other callers without a sync argument leave the list alone.
  storage = openPersistence(f.directory, queue, undefined, { skipped });
  storage.close();
  storage = openPersistence(f.directory, queue);
  storage.close();
  expect(factoryStatus(f.directory).skippedTickets).toEqual(skipped);
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
    reviews: [],
    requests: [],
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
