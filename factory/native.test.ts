import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  configuration,
  effectiveDefinition,
  effectiveConfiguration,
  createFactory,
  migrateDefinition,
  assertControlCaller,
  missingBriefFacts,
  readTicketFile,
  statusSummary,
  tasks,
  type NativeHost,
} from "./native";
import {
  deliveryFixture,
  openStore,
  watchdogFixture,
} from "./bookkeeping.fixture";
import { startDashboard } from "./dashboard";
import { deliverAlerts } from "./watchdog";
import { audit } from "./audit";
import { parseWorkerReport, workerReportExamples } from "./worker-report";
import {
  factoryDefinition,
  evidenceContent,
  factoryEvidence,
  factoryEvents,
  factoryRecords,
  factoryStatus,
  openPersistence,
  runStage,
  type State,
  type ThreadID,
} from "./persistence";

const installer = resolve(import.meta.dir, "setup-factory.ts");
const preparationRoots: string[] = [];

async function auditGateOutcome(
  directory: string,
  outcome: "gate-passed" | "gate-failed" | "post-gate-changed",
  runs: number,
) {
  const states: Array<{ evidence: string }> = [];
  const statePath = join(directory, "state.sqlite");
  const before = await readFile(statePath);
  const result = await audit({
    directory,
    apiKey: "fixture-audit-key",
    fetch: async (_url, init) => {
      if (typeof init.body !== "string") throw new Error("Expected JSON text");
      states.push(JSON.parse(init.body).state);
      return new Response(null, { status: 401 });
    },
  });
  const records = (await Bun.file(result.ledger).json()).records;
  if (outcome === "gate-passed") {
    expect(records).toEqual([]);
    expect(states).toEqual([]);
  } else if (outcome === "post-gate-changed") {
    expect(records).toMatchObject([
      {
        ticket: "A",
        bucket: "unsorted",
        reason: "Post-gate clean tree or candidate revision check failed",
      },
    ]);
    expect(states).toEqual([]);
  } else {
    expect(states).toHaveLength(1);
    expect(states[0]!.evidence).toContain(`run ${runs}\n`);
    expect(states[0]!.evidence).toContain(`error ${runs}\n`);
  }
  expect(await readFile(statePath)).toEqual(before);
}

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
  // CI runners have no global Git identity; every fixture commit uses this one.
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
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
      workerModel: "openai/gpt-6.2-sol",
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
  const notices: string[] = [];
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
    async send(id, message) {
      if (id === "T-owner") {
        notices.push(message);
        return;
      }
      await ready();
      sends++;
    },
    async state() {
      return "running";
    },
    watch() {},
  };
  const { tools, notifications } = watchdogFixture();
  const factory = (now?: () => number) => {
    const engine = createFactory(root, host, openStore, now);
    return {
      ...engine,
      tick(...args: Parameters<typeof engine.tick>) {
        const saved = factoryStatus(engine.directory);
        const [action, owner = saved.owner ?? "T-owner", observe, request] =
          args;
        return engine.tick(
          action,
          owner,
          observe,
          request,
          action === "status" || (!saved.owner && action !== "start")
            ? undefined
            : tools,
        );
      },
    };
  };
  return {
    root,
    worktree,
    host,
    factory,
    git,
    notifications,
    notices,
    counts: () => ({ creates, sends }),
  };
}

afterEach(async () => {
  for (const root of preparationRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function markerFixture(
  timeoutMs: number,
  requireExecution: () => Promise<void>,
) {
  const { root, host } = await preparationFixture(() => "exit 99");
  const config = join(root, ".factory.json");
  await Bun.write(
    config,
    JSON.stringify({
      ...(await Bun.file(config).json()),
      hooks: [
        {
          event: "agent.start",
          action: "create-marker",
          name: "turn",
          timeoutMs,
        },
      ],
    }),
  );
  const owner: ThreadID = "T-owner";
  const engine = createFactory(root, { ...host, requireExecution }, openStore);
  const storage = openPersistence(engine.directory, []);
  storage.commit(
    { enabled: true, owner, runs: {} },
    "factory",
    "fixture",
    "Owner ready",
  );
  storage.close();
  await engine.tick("reload", owner);
  return {
    engine,
    owner,
    deliver: () => engine.nativeHook({ id: "event", thread: { id: owner } }),
    markers: join(engine.directory, "hook-markers"),
  };
}

test("hook permission expiry releases pause and late permission never creates a marker", async () => {
  const entered = Promise.withResolvers<void>();
  const permission = Promise.withResolvers<void>();
  const { engine, owner, deliver, markers } = await markerFixture(50, () => {
    entered.resolve();
    return permission.promise;
  });
  const attempt = deliver();
  await entered.promise;
  const pause = engine.tick("pause", owner);
  try {
    const paused = await Promise.race([pause, Bun.sleep(750).then(() => null)]);
    expect(paused?.enabled).toBe(false);
    expect(
      factoryEvents(engine.directory)?.some(
        ({ action }) => action === "hook-timed-out",
      ),
    ).toBe(true);
  } finally {
    permission.resolve();
    await Promise.all([attempt, pause]);
  }
  await deliver();
  await Bun.sleep(100);
  expect(await readdir(markers).catch(() => null)).toBeNull();
});

test("marker creation stays in the opened directory when its pathname is replaced", async () => {
  const { engine, deliver, markers } = await markerFixture(
    1000,
    async () => {},
  );
  const moved = join(engine.directory, "original-markers");
  const outside = join(engine.directory, "outside-markers");
  await mkdir(outside);
  const spawn = Bun.spawn;
  const substitute = spyOn(Bun, "spawn").mockImplementationOnce(
    (command, options?) => {
      renameSync(markers, moved);
      symlinkSync(outside, markers);
      return Reflect.apply(spawn, Bun, [command, options]);
    },
  );
  try {
    await deliver();
  } finally {
    substitute.mockRestore();
  }
  expect(await readdir(outside)).toEqual([]);
  expect(await readdir(moved)).toEqual([
    expect.stringMatching(/^turn-[a-f0-9]{64}$/),
  ]);
});

test("native hooks hold refused, timed-out and interrupted effects across reload and restart", async () => {
  const { root, host, git, counts } = await preparationFixture(() => "exit 99");
  const configPath = join(root, ".factory.json");
  const raw = await Bun.file(configPath).json();
  const owner = { id: "T-owner" } as const;
  const engine = () =>
    createFactory(root, { ...host, async requireExecution() {} }, openStore);
  const { directory } = engine();
  const markers = join(directory, "hook-markers");
  const base = git("rev-parse", "HEAD");
  const state = {
    enabled: true,
    owner: owner.id,
    runs: {
      A: { kind: "blocked", thread: "T-original", reason: "Stale candidate" },
    },
  } satisfies State;
  const storage = openPersistence(directory, []);
  storage.commit(state, "A", "fixture", "Existing original worker");
  storage.close();
  const configure = (name: string, execute = true, timeoutMs = 1000) =>
    Bun.write(
      configPath,
      JSON.stringify({
        ...raw,
        hooks: [
          { event: "agent.start", action: "create-marker", name, timeoutMs },
        ],
        permissions: { ...raw.permissions, execute },
      }),
    );
  const event = (id: string) => ({ id, thread: owner });
  const outcomes = () =>
    factoryEvents(directory)?.flatMap(({ action }) =>
      action.startsWith("hook-") && action !== "hook-claimed" ? [action] : [],
    );

  await configure("old");
  await engine().nativeHook(event("not-accepted"));
  await engine().tick("reload", owner.id);
  await engine().tick("status");
  expect(await readdir(markers).catch(() => null)).toBeNull();
  await configure("old", false);
  await engine().nativeHook(event("revoked"));
  await configure("new");
  await engine().nativeHook(event("edited"));
  await engine().tick("reload", owner.id);
  await engine().nativeHook(event("revoked"));
  await engine().nativeHook(event("edited"));
  expect(await readdir(markers).catch(() => null)).toBeNull();
  expect(outcomes()).toEqual(["hook-refused", "hook-refused"]);

  await engine().nativeHook(event("allowed"));
  const [created] = await readdir(markers);
  expect(created).toMatch(/^new-[a-f0-9]{64}$/);
  const interrupted = event("interrupted");
  const crash = Bun.spawnSync([
    process.execPath,
    "-e",
    `
      import { createFactory } from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
      import { openStore } from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
      const factory = createFactory(Bun.argv.at(-1), { async requireExecution() {} }, openStore);
      const spawn = Bun.spawn;
      Bun.spawn = (command, options) => spawn([
        "/bin/sh", "-c", '"$@" && kill -KILL "$PPID"', "hook-crash-fixture", ...command
      ], options);
      await factory.nativeHook(${JSON.stringify(interrupted)});
    `,
    root,
  ]);
  const [interruptedMarker] = (await readdir(markers)).filter(
    (name) => name !== created,
  );
  expect(crash.signalCode).toBe("SIGKILL");
  expect(interruptedMarker).toMatch(/^new-[a-f0-9]{64}$/);
  expect(factoryEvents(directory)?.at(-1)?.action).toBe("hook-claimed");
  await rmdir(join(markers, interruptedMarker!));
  await engine().nativeHook(interrupted);
  expect(await readdir(markers)).toEqual([created!]);

  await configure("slow", true, 500);
  await engine().tick("reload", owner.id);
  const spawn = Bun.spawn;
  let slow: ReturnType<typeof Bun.spawn> | undefined;
  const substitute = spyOn(Bun, "spawn").mockImplementationOnce(
    (_, options?) => {
      slow = Reflect.apply(spawn, Bun, [["/bin/sleep", "10"], options]);
      return slow!;
    },
  );
  try {
    await engine().nativeHook(event("timeout"));
    expect(
      await Promise.race([slow?.exited, Bun.sleep(1000).then(() => null)]),
    ).toBe(137);
  } finally {
    substitute.mockRestore();
    slow?.kill("SIGKILL");
  }
  await engine().nativeHook(event("timeout"));
  expect(await readdir(markers)).toEqual([created!]);
  expect(outcomes()).toEqual([
    "hook-refused",
    "hook-refused",
    "hook-succeeded",
    "hook-uncertain",
    "hook-timed-out",
  ]);
  expect(counts()).toEqual({ creates: 0, sends: 0 });
  expect(factoryStatus(directory)).toEqual(state);
  expect(git("rev-parse", "HEAD")).toBe(base);
});

test("brief facts list every gap without quoting private instructions", async () => {
  const f = await preparationFixture(() => "");
  const definition = await configuration(f.root);
  const task = {
    id: "A",
    brief:
      "Implement `docs/missing.md`. Private instructions mention ./other.md.",
    after: ["D", "E"],
  };
  const runs = {
    D: {
      kind: "done" as const,
      thread: "T-D" as const,
      revision: "abc",
      insight: " \t",
    },
    E: {
      kind: "done" as const,
      thread: "T-E" as const,
      revision: "def",
      insight: "Verified",
    },
  };
  expect(
    missingBriefFacts(
      task,
      { ...definition, scope: [], verify: " " },
      runs,
      [],
    ),
  ).toEqual([
    "ticket file at base: docs/missing.md",
    "allowed scope",
    "verification command",
    "dependency insight: D",
  ]);
  expect(
    missingBriefFacts({ ...task, after: [] }, undefined, {}, [
      "docs/missing.md",
      "other.md",
    ]),
  ).toEqual(["pinned definition", "allowed scope", "verification command"]);
  expect(
    missingBriefFacts({ ...task, after: ["E"] }, definition, runs, [
      "docs/missing.md",
      "other.md",
    ]),
  ).toEqual([]);
});

test.each([false, true])(
  "brief refusal precedes creation and setup=%s, holds once, and reload rechecks",
  async (setup) => {
    const f = await preparationFixture(() => "");
    const config = await Bun.file(join(f.root, ".factory.json")).json();
    if (!setup) {
      delete config.setup;
      delete config.setupTimeoutMs;
    }
    await writeFile(join(f.root, ".factory.json"), JSON.stringify(config));
    const queue = [
      {
        id: "A",
        brief: "Implement docs/absent.md. Private instruction.",
        after: [],
        intake: "planned",
        outcome: "Validated work",
      },
      { id: "B", brief: "Independent work", after: [] },
    ];
    await writeFile(join(f.root, "tickets.json"), JSON.stringify(queue));
    await writeFile(
      join(f.root, ".gitignore"),
      "node_modules/\ndocs/absent.md\n",
    );
    await mkdir(join(f.root, "docs"));
    await writeFile(join(f.root, "docs/absent.md"), "Not present at the base");
    f.git("add", ".");
    f.git("commit", "-qm", "missing brief fixture");
    const base = f.git("rev-parse", "HEAD");
    const messages: string[] = [];
    let creates = 0;
    const host: NativeHost = {
      ...f.host,
      async create() {
        creates++;
        return "T-worker";
      },
      async send(_id, message) {
        messages.push(message);
      },
    };
    const engine = createFactory(f.root, host, openStore, () => 1000);
    const storage = openPersistence(engine.directory, tasks(queue), () => 1000);
    storage.admit("A");
    storage.close();
    const { tools } = watchdogFixture();
    const tick = (action: "start" | "reconcile" | "reload" | "pause") =>
      engine.tick(action, "T-owner", host.state, undefined, tools);
    const stopped = await tick("start");
    expect(stopped.runs.A).toMatchObject({
      kind: "blocked",
      reason: "Brief incomplete; missing ticket file at base: docs/absent.md",
      incident: {
        reason: "brief-incomplete",
        base,
        attempt: 0,
        recovery: "inspect",
        delivery: "sent",
      },
    });
    expect(creates).toBe(0);
    expect(
      f.git("worktree", "list", "--porcelain").match(/^worktree /gm),
    ).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Reason: brief-incomplete");
    const events = factoryEvents(engine.directory, 0, 500);
    const reopened = createFactory(f.root, host, openStore, () => 1000);
    expect(
      await reopened.tick("reconcile", "T-owner", host.state, undefined, tools),
    ).toEqual(stopped);
    expect(factoryEvents(engine.directory, 0, 500)).toEqual(events);
    expect(creates).toBe(0);
    expect(messages).toHaveLength(1);
    await tick("reload");
    const stillMissing = await tick("reconcile");
    expect(stillMissing.runs.A).toMatchObject({
      kind: "blocked",
      incident: { reason: "brief-incomplete", base, attempt: 0 },
    });
    expect(stillMissing.runs.A?.incident?.id).not.toBe(
      stopped.runs.A?.incident?.id,
    );
    expect(creates).toBe(0);
    // A queue fix must replace even an admitted ticket's frozen briefing, not its intake.
    queue[0]!.brief = "Implement prd.md";
    await writeFile(join(f.root, "tickets.json"), JSON.stringify(queue));
    f.git("add", ".");
    f.git("commit", "-qm", "fix brief fixture");
    const configured = factoryEvents(engine.directory, 0, 500)!.filter(
      (event) => event.ticket === "A" && event.action === "configured",
    );
    for (const caller of [undefined, "T-stranger" as const]) {
      const outsider = await engine.tick("reload", caller);
      expect(outsider.runs.A).toEqual(stillMissing.runs.A);
      expect(
        factoryEvents(engine.directory, 0, 500)!.filter(
          (event) => event.ticket === "A" && event.action === "configured",
        ),
      ).toEqual(configured);
      const stored = openPersistence(engine.directory, []);
      try {
        expect(stored.tickets.find((task) => task.id === "A")).toMatchObject({
          id: "A",
          brief: "Implement docs/absent.md. Private instruction.",
          intake: "admitted",
          after: [],
        });
      } finally {
        stored.close();
      }
    }
    await tick("pause");
    const loaded = await tick("reload");
    expect(loaded.enabled).toBe(false);
    expect(loaded.runs.A).toBeUndefined();
    expect(creates).toBe(0);
    const replacement = factoryEvents(engine.directory, 0, 500)!
      .filter((event) => event.ticket === "A" && event.action === "configured")
      .at(-1)!;
    expect(JSON.parse(replacement.detail)).toMatchObject({
      id: "A",
      brief: "Implement prd.md",
      intake: "admitted",
      after: [],
    });
    const started = await tick("start");
    expect(started.runs.A?.kind).toBe("running");
    expect(creates).toBe(1);
    const run = started.runs.A;
    if (run?.kind !== "running") throw new Error("Expected complete worker");
    expect(messages.at(-1)).toMatch(/^factory-key: [a-f0-9]{64}\n/);
    expect(messages.at(-1)?.replace(/^factory-key: [a-f0-9]{64}\n/, "")).toBe(
      `Read and apply the poteto-mode skill within these restrictions: ~/.cache/amp/{global-skills,global-skill-manifests}/ampcode.com/user/poteto-mode*/SKILL.md.
Work only in your worktree ${run.worktree}. Ticket A: Implement prd.md\nAllowed paths: src/. Check: true.\nDefinition: ${run.definition}.\nDependency evidence: none.\nUse a local commit for the change. Do not push, deploy, create tickets, edit factory files, or delegate.\nForeman: T-owner. Send questions and blockers with the factory control action message-foreman and message text. Messaging does not grant factory control.\nAfter finishing, write JSON to ${join(engine.directory, "A.report.json")}: {"attempt":1,"kind":"candidate","revision":"<full git HEAD>","insight":"<short verified finding>","summary":"<optional public line>"}. If blocked, use {"attempt":1,"kind":"blocked","reason":"<needed decision>"}. Report briefly here too.`,
    );
  },
);

test.each(["normal", "superseded", "absent", "present", "empty", "sent"])(
  "phase lessons reach only relevant workers (handoff: %s)",
  async (scenario) => {
    const f = await preparationFixture(() => "");
    const config = await Bun.file(join(f.root, ".factory.json")).json();
    delete config.setup;
    delete config.setupTimeoutMs;
    await writeFile(join(f.root, ".factory.json"), JSON.stringify(config));
    const queue = [
      { id: "A", brief: "Source", after: [] },
      { id: "B", brief: "Dependent", after: ["A"], lessonScope: ["src/ui/"] },
      {
        id: "C",
        brief: "Unrelated",
        after: [],
        lessonScope: ["src/auth-old/"],
      },
      {
        id: "D",
        brief: "Affected",
        after: [],
        lessonScope: ["src/auth/guard.ts"],
      },
    ];
    await writeFile(join(f.root, "tickets.json"), JSON.stringify(queue));
    f.git("add", ".");
    f.git("commit", "-qm", "lesson fixture");
    const revision = f.git("rev-parse", "HEAD");
    const messages: { thread: string; message: string }[] = [];
    let refuseHandoff = scenario !== "normal";
    let lookup: "inconclusive" | "absent" | "present" = "inconclusive";
    const host: NativeHost = {
      async create() {
        return "T-B";
      },
      async send(thread, message) {
        if (thread === "T-B" && refuseHandoff) {
          refuseHandoff = false;
          if (scenario === "present" || scenario === "sent")
            messages.push({ thread, message });
          throw new Error("Interrupted delivery");
        }
        messages.push({ thread, message });
      },
      async lookupDelivery() {
        return lookup;
      },
      async state() {
        return "running";
      },
      watch() {},
    };
    let engine = createFactory(f.root, host, openStore);
    const saved = openPersistence(engine.directory, queue);
    saved.state.owner = "T-owner";
    saved.state.enabled = true;
    for (const task of queue.filter(({ id }) => id !== "B")) {
      saved.state.runs[task.id] = {
        kind: "running",
        base: revision,
        worktree: f.root,
        thread: `T-${task.id}`,
        attempt: 1,
        delivery: "sent",
        lessonScope: task.lessonScope,
      };
    }
    saved.commit(saved.state, "A", "gate-returned", revision, [
      {
        attempt: 1,
        kind: "gate",
        definition: null,
        revision,
        outcome: "gate-passed",
        tool: "true",
        content: "auth check passed",
      },
    ]);
    const evidence = saved.proof("A", 1, revision).map(({ sha256 }) => sha256);
    saved.close();
    const lesson = {
      ticket: "A",
      phase: "gate",
      sourceThread: "T-A",
      revision,
      attempt: 1,
      scope: ["src/auth/"],
      evidence,
      findings: ["Run the auth guard before opening a session."],
      failedApproaches: ["Opening the session first failed."],
      questions: ["Does the CLI share the guard?"],
    };
    expect(engine.recordLesson(lesson, "T-D")).rejects.toThrow();
    const original =
      scenario === "empty"
        ? undefined
        : await engine.recordLesson(lesson, "T-owner");
    expect(factoryStatus(engine.directory).runs.A?.kind).toBe("running");
    expect(factoryStatus(engine.directory).runs.B).toBeUndefined();
    engine = createFactory(f.root, host, openStore);
    if (original) await engine.recordLesson(lesson, "T-owner");
    expect(messages.map(({ thread }) => thread)).toEqual(
      original ? ["T-D"] : [],
    );

    const landed = openPersistence(engine.directory, []);
    for (const id of ["A", "C", "D"])
      landed.state.runs[id] = {
        kind: "done",
        revision,
        insight: "Accepted separately.",
        thread: `T-${id}`,
      };
    landed.commit(landed.state, "A", "accepted", revision);
    landed.close();
    const { tools } = watchdogFixture();
    const reconcile = () =>
      engine.tick("reconcile", "T-owner", host.state, undefined, tools);
    let dependent = lesson;
    async function recoverInterruptedHandoff() {
      await reconcile().catch(() => {});
      expect(factoryStatus(engine.directory).runs.B).toMatchObject({
        delivery: "sending",
      });
      const replacementRevision = "d".repeat(40);
      const proof = openPersistence(engine.directory, []);
      proof.record("A", [
        {
          attempt: 1,
          kind: "gate",
          definition: null,
          tool: "true",
          outcome: "gate-passed",
          revision: replacementRevision,
          content: "corrected auth check",
        },
      ]);
      dependent = {
        ...lesson,
        revision: replacementRevision,
        evidence: proof
          .proof("A", 1, replacementRevision)
          .map(({ sha256 }) => sha256),
        findings: ["Run the auth guard after opening a session."],
      };
      proof.close();
      await engine.recordLesson(
        {
          ...dependent,
          ...(scenario === "superseded"
            ? { supersedes: original!.lesson.id }
            : {}),
        },
        "T-owner",
      );
      engine = createFactory(f.root, host, openStore);
      const beforeLookup = messages.length;
      if (scenario === "sent") {
        const delivered = openPersistence(engine.directory, []);
        const run = delivered.state.runs.B;
        if (run?.kind !== "running")
          throw new Error("Expected delivered worker");
        run.delivery = "sent";
        delete run.incident;
        delivered.commit(delivered.state, "B", "sent", run.thread);
        delivered.close();
      } else {
        await reconcile();
        expect(messages).toHaveLength(beforeLookup);
        lookup = scenario === "present" ? "present" : "absent";
      }
      await reconcile();
    }
    if (scenario !== "normal") await recoverInterruptedHandoff();
    await reconcile();
    assertHandoff();

    function assertHandoff() {
      const taught = messages.filter(({ message }) =>
        message.includes("Phase lesson "),
      );
      const expected =
        scenario === "present" || scenario === "sent"
          ? ["T-D", "T-B", "T-B"]
          : original
            ? ["T-D", "T-B"]
            : ["T-B"];
      expect(taught.map(({ thread }) => thread)).toEqual(expected);
      if (original) expect(taught[0]?.message).toContain(lesson.findings[0]!);
      const handoff = taught.at(-1)?.message;
      expect(handoff).toContain(dependent.findings[0]!);
      expect(handoff).toContain(dependent.revision);
      expect(handoff).toContain(dependent.evidence[0]!);
      expect(handoff).not.toContain(lesson.failedApproaches[0]!);
      expect(handoff).not.toContain(lesson.questions[0]!);
      const dependentMessages = taught.filter(({ thread }) => thread === "T-B");
      expect(
        dependentMessages.filter(({ message }) =>
          message.includes(lesson.findings[0]!),
        ),
      ).toHaveLength(
        ["normal", "present", "absent", "sent"].includes(scenario) ? 1 : 0,
      );
    }
  },
);

test("brief refusal repairs accepted empty evidence through owner control actions only", async () => {
  const f = await preparationFixture(() => "");
  const config = await Bun.file(join(f.root, ".factory.json")).json();
  delete config.setup;
  delete config.setupTimeoutMs;
  await writeFile(join(f.root, ".factory.json"), JSON.stringify(config));
  const queue = [
    { id: "D", brief: "Dependency", after: [] },
    { id: "A", brief: "Work", after: ["D"] },
    { id: "B", brief: "Independent", after: [] },
  ];
  await writeFile(join(f.root, "tickets.json"), JSON.stringify(queue));
  f.git("add", ".");
  f.git("commit", "-qm", "dependency fixture");
  let creates = 0;
  const messages: string[] = [];
  const host: NativeHost = {
    async create() {
      return `T-worker-${++creates}`;
    },
    async send(_thread, message) {
      messages.push(message);
    },
    async state() {
      return "idle";
    },
    watch() {},
  };
  const engine = createFactory(f.root, host, openStore, () => 1000);
  const { tools } = watchdogFixture();
  await engine.tick("start", "T-owner", host.state, undefined, tools);
  const worktree = join(engine.directory, "worktrees/D");
  await mkdir(join(worktree, "src"));
  await writeFile(join(worktree, "src/value"), "verified");
  f.git("-C", worktree, "add", ".");
  f.git("-C", worktree, "commit", "-qm", "dependency candidate");
  const revision = f.git("-C", worktree, "rev-parse", "HEAD");
  f.git("merge", "--ff-only", revision);
  const legacy = openPersistence(engine.directory, queue);
  legacy.state.runs.D = {
    kind: "done",
    revision,
    insight: "",
    thread: "T-worker-1",
  };
  legacy.commit(legacy.state, "D", "accepted", revision);
  legacy.close();
  const stopped = await engine.tick(
    "reconcile",
    "T-owner",
    host.state,
    undefined,
    tools,
  );
  expect(stopped.runs.D).toMatchObject({ kind: "done", insight: "", revision });
  expect(stopped.runs.A).toMatchObject({
    kind: "blocked",
    reason: "Brief incomplete; missing dependency insight: D",
    incident: { reason: "brief-incomplete", attempt: 0 },
  });
  expect(creates).toBe(1);
  const before = factoryEvents(engine.directory, 0, 500);
  const record = (ticket: string, insight: string, caller?: ThreadID) =>
    engine.tick(
      "record-insight",
      caller,
      host.state,
      undefined,
      undefined,
      ticket,
      insight,
    );
  for (const caller of [
    undefined,
    "T-stranger" as const,
    "T-worker-1" as const,
  ])
    expect(
      record("D", "Verified dependency behavior", caller),
    ).rejects.toThrow();
  expect(record("A", "Not accepted", "T-owner")).rejects.toThrow();
  expect(record("D", " ", "T-owner")).rejects.toThrow();
  expect(factoryEvents(engine.directory, 0, 500)).toEqual(before);
  const recorded = await record("D", "Verified dependency behavior", "T-owner");
  const dependency = stopped.runs.D;
  if (dependency?.kind !== "done")
    throw new Error("Expected accepted dependency");
  expect(recorded.runs.D).toEqual({
    ...dependency,
    insight: "Verified dependency behavior",
  });
  expect(recorded.runs.A).toEqual(stopped.runs.A);
  const events = factoryEvents(engine.directory, 0, 500);
  await record("D", "Verified dependency behavior", "T-owner");
  expect(record("D", "Replace evidence", "T-owner")).rejects.toThrow();
  expect(factoryEvents(engine.directory, 0, 500)).toEqual(events);
  expect(creates).toBe(1);
  const loaded = await engine.tick(
    "reload",
    "T-owner",
    host.state,
    undefined,
    tools,
  );
  expect(loaded.runs.A).toBeUndefined();
  expect(
    (await engine.tick("reconcile", "T-owner", host.state, undefined, tools))
      .runs.A?.kind,
  ).toBe("running");
  expect(creates).toBe(2);
  expect(messages.at(-1)).toContain(
    `Dependency evidence: D: Verified dependency behavior (${revision}).`,
  );
});

test.each([
  "Create docs/new-guide.md and read SKILL.md",
  "Implement prd.md. Read SKILL.md and changelog.md; create docs/new-guide.md",
])("complete brief ignores non-ticket Markdown mentions: %s", async (brief) => {
  const f = await preparationFixture(() => "");
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([{ id: "A", brief, after: [] }]),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "complete brief fixture");
  const messages: string[] = [];
  const send = f.host.send.bind(f.host);
  f.host.send = async (thread, message) => {
    messages.push(message);
    await send(thread, message);
  };
  const state = await f.factory().tick("start");
  expect(state.runs.A?.kind).toBe("running");
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
  expect(messages[0]).toContain(`Ticket A: ${brief}\nAllowed paths:`);
});

async function handoffFixture() {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const old = watchdogFixture();
  const next = watchdogFixture("T-new", old.schedules);
  await engine.tick("start", "T-owner", f.host.state, undefined, old.tools);
  const storage = openPersistence(engine.directory, []);
  try {
    const run = storage.state.runs.A;
    if (run?.kind !== "running") throw new Error("Expected dispatched fixture");
    storage.state.runs.A = {
      kind: "blocked",
      thread: run.thread,
      reason: "Verification rejected",
      repair: { ...run, attempt: 2 },
      watchdog: run.watchdog,
      incident: {
        id: "stop-exact",
        owner: "T-owner",
        ticket: "A",
        attempt: 2,
        base: run.base,
        reason: "verification-rejected",
        recovery: "resume",
        delivery: "sent",
        notifiedAt: 500,
      },
    };
    storage.commit(storage.state, "A", "fixture-stop", "");
  } finally {
    storage.close();
  }
  f.host.state = async () => "idle";
  const notices: { thread: string; message: string }[] = [];
  f.host.send = async (thread, message) => {
    notices.push({ thread, message });
  };
  return { ...f, engine, old, next, notices };
}

test("handoff preserves workers and incident identity, reissues stops, and permits exact recovery", async () => {
  const f = await handoffFixture();
  await f.engine.note("Keep the existing worker", "T-owner");
  await f.engine.note("Live acceptance is pending", "T-owner");
  const before = factoryStatus(f.engine.directory);
  const engine = createFactory(f.root, f.host, openStore, () => 2000);
  const request = {
    owner: "T-owner",
    decision: "Provider limit stopped the Foreman",
  };
  const result = await engine.handoff(request, "T-new", f.next.tools);
  expect(result.owner).toBe("T-new");
  expect(result.enabled).toBe(true);
  expect(result.runs.A).toEqual({
    ...before.runs.A,
    incident: {
      ...before.runs.A!.incident!,
      owner: "T-new" as const,
      delivery: "sent" as const,
      notifiedAt: 2000,
    },
  });
  expect(result.foreman?.notes).toEqual([
    { at: 1000, thread: "T-owner", text: "Keep the existing worker" },
    { at: 1000, thread: "T-owner", text: "Live acceptance is pending" },
  ]);
  expect(f.notices).toEqual([
    { thread: "T-new", message: expect.stringContaining("stop-exact") },
  ]);
  expect([...f.old.schedules.keys()]).toEqual(["T-new"]);
  expect(f.old.schedules.get("T-new")).toMatchObject({
    enabled: true,
    targetThreadID: "T-new",
  });
  const bytes = await readFile(join(engine.directory, "state.sqlite"));
  expect(await engine.handoff(request, "T-new", f.next.tools)).toEqual(result);
  expect(await readFile(join(engine.directory, "state.sqlite"))).toEqual(bytes);
  expect(f.notices).toHaveLength(1);
  for (const action of [
    "start",
    "pause",
    "reconcile",
    "reload",
    "resume",
  ] as const)
    expect(engine.tick(action, "T-owner")).rejects.toThrow("no longer owns");
  expect(engine.note("Stale owner", "T-owner")).rejects.toThrow(
    "operator decides any handoff",
  );
  await engine.tick("pause", "T-new", f.host.state, undefined, f.next.tools);
  const resumed = await engine.tick(
    "resume",
    "T-new",
    f.host.state,
    {
      ticket: "A",
      incident: "stop-exact",
      decision: "Fix the verification failure",
    },
    f.next.tools,
  );
  expect(resumed.enabled).toBe(false);
  expect(resumed.runs.A).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    attempt: 3,
    delivery: "queued",
  });
  expect(f.counts().creates).toBe(1);
});

async function handoffGuardFixture(fault: string) {
  const f = await handoffFixture();
  const storage = openPersistence(f.engine.directory, []);
  try {
    if (fault === "pending") storage.state.monitor!.pendingThread = "T-owner";
    if (fault === "fingerprint")
      storage.state.monitor!.fingerprint = "copied-root";
    if (fault === "reviewer") {
      const run = storage.state.runs.A;
      if (run?.kind !== "blocked" || !run.repair)
        throw new Error("Expected repair");
      storage.state.runs.Review = {
        ...run.repair,
        review: {
          ticket: "A",
          attempt: 2,
          base: run.repair.base,
          revision: "b".repeat(40),
          stage: "post-graft",
          worktree: "/TEST/review",
          report: "/TEST/verdict",
          log: "/TEST/log",
          model: "anthropic/reviewer",
          command: "true",
          delivery: "sent",
          thread: "T-reviewer",
        },
      };
    }
    storage.commit(storage.state, "factory", "fixture-guard", "");
  } finally {
    storage.close();
  }
  return f;
}

test.each([
  "wrong-owner",
  "empty-decision",
  "missing-decision",
  "worker",
  "reviewer",
  "running",
  "unknown",
  "disconnected",
  "pending",
  "fingerprint",
])("handoff refuses %s without changing state or schedules", async (fault) => {
  const f = await handoffGuardFixture(fault);
  const before = factoryStatus(f.engine.directory);
  const bytes = await readFile(join(f.engine.directory, "state.sqlite"));
  const schedules = structuredClone(f.old.schedules);
  const request = {
    owner: fault === "wrong-owner" ? "T-wrong" : "T-owner",
    decision:
      fault === "empty-decision"
        ? "  "
        : fault === "missing-decision"
          ? undefined
          : "Take over",
  };
  const caller =
    fault === "worker"
      ? "T-prepared"
      : fault === "reviewer"
        ? "T-reviewer"
        : "T-new";
  expect(
    f.engine.handoff(
      request,
      caller,
      fault === "disconnected" ? undefined : f.next.tools,
      async () =>
        fault === "running"
          ? "running"
          : fault === "unknown"
            ? "unknown"
            : "idle",
    ),
  ).rejects.toThrow();
  expect(factoryStatus(f.engine.directory)).toEqual(before);
  expect(await readFile(join(f.engine.directory, "state.sqlite"))).toEqual(
    bytes,
  );
  expect(f.old.schedules).toEqual(schedules);
  expect(f.notices).toEqual([]);
});

async function handoffScheduleFixture(fault: string) {
  const f = await handoffFixture();
  let effects = 0;
  let clears = 0;
  let targetedReads = 0;
  let blocked = true;
  if (fault === "absent") f.old.schedules.delete("T-owner");
  if (fault === "foreign")
    f.old.schedules.set("T-owner", {
      title: "Unrelated",
      prompt: "Keep",
      targetThreadID: "T-owner",
    });
  if (fault === "wrong-target")
    f.old.schedules.get("T-owner")!.targetThreadID = "T-other";
  async function readOld() {
    targetedReads++;
    if (blocked && fault === "unrecognized-read") return {};
    if (
      blocked &&
      (fault === "unreadable" || (fault === "lost-inspection" && clears > 0))
    )
      throw new Error("Old thread unavailable");
    return f.next.tools.call("amp.get_schedule", { thread: "T-owner" });
  }
  async function clearOld() {
    clears++;
    expect(factoryStatus(f.engine.directory).owner).toBe("T-new");
    if (fault === "denied" && blocked) throw new Error("Permission refused");
    if (fault === "false-success" && blocked) return { deleted: true };
    const result = await f.next.tools.call("amp.clear_schedule", {
      thread: "T-owner",
    });
    if (fault === "unrecognized-clear" && blocked) return {};
    if (fault === "replaced")
      f.old.schedules.set("T-owner", {
        title: "Unrelated",
        prompt: "Keep",
        targetThreadID: "T-owner",
      });
    if (fault === "lost-ack") throw new Error("Lost clear acknowledgment");
    return result;
  }
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.get_schedule" && input.thread === "T-owner")
        return readOld();
      if (name === "amp.clear_schedule" && input.thread === "T-owner")
        return clearOld();
      if (name === "amp.set_schedule") effects++;
      return f.next.tools.call(name, input);
    },
  };
  return {
    ...f,
    tools,
    effects: () => ({ installs: effects, clears, reads: targetedReads }),
    unblock() {
      blocked = false;
      if (fault === "wrong-target")
        f.old.schedules.get("T-owner")!.targetThreadID = "T-owner";
    },
  };
}

test.each([
  ["cleared", false, 1, 2],
  ["lost-ack", true, 1, 2],
  ["denied", true, 1, 2],
  ["false-success", true, 1, 2],
  ["unreadable", true, 0, 1],
  ["lost-inspection", true, 1, 2],
  ["foreign", false, 0, 1],
  ["wrong-target", true, 0, 1],
  ["absent", false, 0, 1],
  ["unrecognized-read", true, 0, 1],
  ["unrecognized-clear", true, 1, 2],
  ["replaced", false, 1, 2],
] as const)(
  "handoff watchdog follows the owner despite %s cleanup",
  async (fault, failed, clears, reads) => {
    const f = await handoffScheduleFixture(fault);
    const result = await f.engine.handoff(
      { owner: "T-owner", decision: "Take over" },
      "T-new",
      f.tools,
    );
    expect(result.owner).toBe("T-new");
    expect(result.monitor!.schedule).toBe("installed");
    expect(result.foreman!.handoffs.at(-1)!.clear).toBe(
      failed ? "unreachable" : "cleared",
    );
    expect(f.effects()).toEqual({ installs: 1, clears, reads });
    if (failed) {
      expect(result.foreman?.handoffs.at(-1)?.problem).toMatch(
        /inspection|unconfirmed/,
      );
      expect(f.next.notifications).toHaveLength(1);
      f.unblock();
      const engine = createFactory(f.root, f.host, openStore);
      const recovered = await engine.tick(
        "reload",
        "T-new",
        f.host.state,
        undefined,
        f.tools,
      );
      expect(recovered.monitor?.schedule).toBe("installed");
      expect(recovered.foreman?.handoffs.at(-1)?.clear).toBe("cleared");
      expect(f.old.schedules.has("T-new")).toBe(true);
      expect(f.next.notifications).toHaveLength(1);
      expect(f.effects().installs).toBe(1);
    }
    if (["foreign", "replaced"].includes(fault))
      expect(f.old.schedules.get("T-owner")).toEqual({
        title: "Unrelated",
        prompt: "Keep",
        targetThreadID: "T-owner",
      });
  },
);

test("unreachable cleanup permits start and hand-back without clearing the returning owner's wake", async () => {
  const f = await handoffScheduleFixture("denied");
  await f.engine.handoff(
    { owner: "T-owner", decision: "Take over" },
    "T-new",
    f.tools,
  );
  await f.engine.tick("pause", "T-new", f.host.state, undefined, f.tools);
  const started = await f.engine.tick(
    "start",
    "T-new",
    f.host.state,
    undefined,
    f.tools,
  );
  expect(started.enabled).toBe(true);
  expect(started.monitor?.schedule).toBe("installed");
  expect(started.foreman?.handoffs[0]?.clear).toBe("unreachable");
  expect(f.next.notifications).toHaveLength(1);
  expect(
    f.engine.tick("reconcile", "T-owner", f.host.state, undefined, f.old.tools),
  ).rejects.toThrow(/handoff/);
  const back = await f.engine.handoff(
    { owner: "T-new", decision: "Hand back despite unreachable cleanup" },
    "T-owner",
    f.old.tools,
  );
  expect(back.owner).toBe("T-owner");
  expect(back.enabled).toBe(true);
  expect(back.foreman?.handoffs.map((handoff) => handoff.clear)).toEqual([
    "unreachable",
    "cleared",
  ]);
  await f.engine.tick(
    "reload",
    "T-owner",
    f.host.state,
    undefined,
    f.old.tools,
  );
  expect([...f.old.schedules.keys()]).toEqual(["T-owner"]);
  expect(factoryStatus(f.engine.directory).monitor?.schedule).toBe("installed");
  expect(f.counts().creates).toBe(1);
  const third = watchdogFixture("T-third", f.old.schedules);
  const movedAgain = await f.engine.handoff(
    { owner: "T-owner", decision: "Take over after hand-back" },
    "T-third",
    third.tools,
  );
  expect(movedAgain.foreman?.handoffs.map((handoff) => handoff.clear)).toEqual([
    "cleared",
    "cleared",
    "cleared",
  ]);
  expect([...f.old.schedules.keys()]).toEqual(["T-third"]);
  expect(movedAgain.monitor?.schedule).toBe("installed");
  expect(third.notifications).toHaveLength(0);
});

test("connected reconciles retry unresolved cleanup from earlier handoffs", async () => {
  const f = await handoffScheduleFixture("denied");
  await f.engine.handoff(
    { owner: "T-owner", decision: "Take over" },
    "T-new",
    f.tools,
  );
  const third = watchdogFixture("T-third", f.old.schedules);
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.clear_schedule" && input.thread === "T-owner")
        throw new Error("Old thread still unreachable");
      return third.tools.call(name, input);
    },
  };
  const moved = await f.engine.handoff(
    { owner: "T-new", decision: "Further guarded takeover" },
    "T-third",
    tools,
  );
  expect(moved.monitor?.schedule).toBe("installed");
  expect(moved.foreman?.handoffs.map((handoff) => handoff.clear)).toEqual([
    "unreachable",
    "cleared",
  ]);
  expect([...f.old.schedules.keys()]).toEqual(["T-owner", "T-third"]);
  const reopened = createFactory(f.root, f.host, openStore);
  const recovered = await reopened.tick(
    "reload",
    "T-third",
    f.host.state,
    undefined,
    third.tools,
  );
  expect(recovered.foreman?.handoffs.map((handoff) => handoff.clear)).toEqual([
    "cleared",
    "cleared",
  ]);
  expect([...f.old.schedules.keys()]).toEqual(["T-third"]);
  expect(f.next.notifications).toHaveLength(1);
  expect(third.notifications).toHaveLength(0);
});

test("a handoff cleanup alert is durably reserved and not resent after an unknown send", async () => {
  const f = await handoffScheduleFixture("denied");
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name !== "amp.notify_user") return f.tools.call(name, input);
      expect(factoryStatus(f.engine.directory).monitor?.notifications).toEqual([
        { id: "handoff-0", at: 1000, outcome: "sending" },
      ]);
      await f.tools.call(name, input);
      throw new Error("Notification acknowledgment lost");
    },
  };
  const moved = await f.engine.handoff(
    { owner: "T-owner", decision: "Take over" },
    "T-new",
    tools,
  );
  expect(moved.monitor?.schedule).toBe("installed");
  expect(moved.monitor?.notifications).toEqual([
    { id: "handoff-0", at: 1000, outcome: "unknown" },
  ]);
  const reopened = createFactory(f.root, f.host, openStore);
  await reopened.tick("reload", "T-new", f.host.state, undefined, tools);
  expect(f.next.notifications).toHaveLength(1);
  expect(factoryStatus(f.engine.directory).foreman?.handoffs[0]?.clear).toBe(
    "unreachable",
  );
});

test("paused handoff and hand-back never start execution or install a watchdog", async () => {
  const f = await handoffFixture();
  await f.engine.tick("pause", "T-owner", f.host.state, undefined, f.old.tools);
  const next = await f.engine.handoff(
    { owner: "T-owner", decision: "Paused takeover" },
    "T-new",
    f.next.tools,
  );
  expect(next.enabled).toBe(false);
  expect(next.monitor?.schedule).toBe("cleared");
  expect(f.old.schedules.size).toBe(0);
  const back = await f.engine.handoff(
    { owner: "T-new", decision: "Hand back" },
    "T-owner",
    f.old.tools,
  );
  expect(back.owner).toBe("T-owner");
  expect(back.enabled).toBe(false);
  expect(back.foreman?.handoffs.map((handoff) => handoff.clear)).toEqual([
    "cleared",
    "cleared",
  ]);
  expect(f.old.notifications).toHaveLength(0);
  expect(f.next.notifications).toHaveLength(0);
  expect(back.runs.A?.incident).toMatchObject({
    id: "stop-exact",
    owner: "T-owner",
  });
  expect(f.old.schedules.size).toBe(0);
  expect(f.counts().creates).toBe(1);
});

async function repeatedPatchRangeFixture() {
  const f = await preparationFixture(() => "");
  const lines = Array.from({ length: 100 }, (_, i) => `site ${i}`);
  await writeFile(join(f.root, "guards"), lines.join("\n") + "\n");
  f.git("add", "guards");
  f.git("commit", "-qm", "two guard sites");
  const base = f.git("rev-parse", "HEAD");
  f.git("worktree", "add", "--detach", f.worktree, base);
  const commits: string[] = [];
  for (const site of [3, 91]) {
    lines.splice(site, 0, "guard();");
    await writeFile(join(f.worktree, "guards"), lines.join("\n") + "\n");
    f.git("-C", f.worktree, "commit", "-qam", `guard site ${site}`);
    commits.push(f.git("-C", f.worktree, "rev-parse", "HEAD"));
  }
  const ids = commits.map(
    (revision) =>
      execFileSync("git", ["-C", f.root, "patch-id", "--stable"], {
        input: f.git("show", "--format=", "-U0", revision),
        encoding: "utf8",
      }).split(/\s/)[0],
  );
  expect(ids[0]).toMatch(/^[a-f0-9]{40}$/);
  expect(ids[0]).toBe(ids[1]);
  return { f, base, commits, revision: commits[1]! };
}

async function acceptedRangeFixture(landing: string) {
  if (landing.startsWith("repeated-")) return repeatedPatchRangeFixture();
  const f = await preparationFixture(() => "");
  const base = f.git("rev-parse", "HEAD");
  f.git("worktree", "add", "--detach", f.worktree, base);
  const workerGit = (...args: string[]) => f.git("-C", f.worktree, ...args);
  const commits: string[] = [];
  if (landing !== "no-change") {
    if (landing !== "empty-only" && landing !== "empty-missing") {
      await writeFile(join(f.worktree, "first"), "first change\n");
      workerGit("add", "first");
    }
    workerGit("commit", "--allow-empty", "-qm", "first candidate");
    commits.push(workerGit("rev-parse", "HEAD"));
    if (landing !== "single" && landing !== "empty-only") {
      if (landing === "net-zero") workerGit("rm", "first");
      else {
        await writeFile(join(f.worktree, "second"), "second change\n");
        workerGit("add", "second");
      }
      workerGit("commit", "-qm", "second candidate");
      commits.push(workerGit("rev-parse", "HEAD"));
    }
  }
  return { f, base, commits, revision: workerGit("rev-parse", "HEAD") };
}

test.each(
  ["record-landing", "record-merge"].flatMap((action) =>
    [
      "single",
      "cherry-picked",
      "squashed",
      "partial",
      "altered",
      "empty-missing",
      "empty-only",
      "no-change",
      "net-zero",
      "repeated-partial",
      "repeated-complete",
    ].map((landing) => ({ action, landing })),
  ),
)(
  "$action proves $landing landing without side effects",
  async ({ action, landing }) => {
    const { f, base, commits, revision } = await acceptedRangeFixture(landing);
    await writeFile(join(f.root, "unrelated"), "upstream change\n");
    f.git("add", "unrelated");
    f.git("commit", "-qm", "advance target");
    if (landing === "squashed") {
      f.git("merge", "--squash", revision);
      f.git("commit", "-qm", "squashed candidate");
    } else if (landing === "altered") {
      f.git("cherry-pick", commits[0]!);
      await writeFile(join(f.root, "second"), "altered change\n");
      f.git("add", "second");
      f.git("commit", "-qm", "altered second candidate");
    } else if (landing.startsWith("empty-") || landing === "no-change") {
      f.git("commit", "--allow-empty", "-qm", "empty landing");
    } else {
      const picks = landing.endsWith("partial") ? commits.slice(0, 1) : commits;
      for (const pick of picks) {
        f.git("cherry-pick", pick);
        expect(f.git("rev-parse", "HEAD")).not.toBe(pick);
      }
    }
    const commit = f.git("rev-parse", "HEAD");
    const branch = f.git("branch", "--show-current");
    f.git("remote", "add", "origin", f.root);
    f.git("update-ref", `refs/remotes/origin/${branch}`, commit);
    f.git("branch", `--set-upstream-to=origin/${branch}`, branch);
    const engine = f.factory();
    const storage = openPersistence(engine.directory, []);
    storage.commit(
      {
        enabled: false,
        owner: "T-owner",
        runs: {
          A:
            action === "record-merge"
              ? {
                  kind: "done",
                  thread: "T-prepared",
                  revision,
                  acceptedBase: base,
                  insight: "accepted",
                }
              : {
                  kind: "blocked",
                  thread: "T-prepared",
                  reason: "Target changed",
                  incident: {
                    id: "landing-stop",
                    ticket: "A",
                    owner: "T-owner",
                    base,
                    attempt: 1,
                    reason: "target-changed",
                    recovery: "inspect",
                    delivery: "sent",
                  },
                },
        },
      },
      "A",
      "fixture",
      "accepted candidate",
    );
    storage.close();
    f.host.state = async () => {
      throw new Error("Must not observe threads");
    };
    const request = {
      ticket: "A",
      revision,
      commit,
      pr: 32,
      incident: "landing-stop",
      decision: "Operator approved external landing",
    };
    f.host.readPullRequest = () => ({
      state: "MERGED",
      merge: commit,
      head: revision,
      checks: [
        {
          __typename: "CheckRun",
          name: "quality",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ],
    });
    const record = () =>
      action === "record-merge"
        ? f.factory().recordMerge(request, "T-owner")
        : f.factory().recordLanding(request, "T-owner");
    const path = join(engine.directory, "state.sqlite");
    const before = await readFile(path);
    if (
      [
        "single",
        "cherry-picked",
        "squashed",
        "net-zero",
        "repeated-complete",
      ].includes(landing)
    ) {
      expect(await record()).toMatchObject({
        enabled: false,
        runs: {
          A: {
            kind: "done",
            revision,
            acceptedBase: base,
            merge: { pr: 32, commit },
          },
        },
      });
      const after = await readFile(path);
      expect(runStage(factoryStatus(engine.directory).runs.A)).toMatchObject({
        stage: "merged",
        actor: null,
        status: "accepted",
      });
      await record();
      expect(await readFile(path)).toEqual(after);
      expect(
        factoryEvents(engine.directory)?.filter(
          (event) =>
            event.action ===
            (action === "record-merge" ? "merge-recorded" : "landed-outside"),
        ),
      ).toHaveLength(1);
    } else {
      expect(await record().catch(String)).toContain(
        "does not contain the accepted change",
      );
      expect(await readFile(path)).toEqual(before);
      const unchanged: Record<string, string> = {
        "record-merge": "accepted",
        "record-landing": "blocked",
      };
      expect<string>(
        runStage(factoryStatus(engine.directory).runs.A).stage,
      ).toBe(unchanged[action]!);
    }
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  },
);

async function renamedCandidateFixture(
  landing: string,
  old: string,
  moved: string,
  initial: string | Buffer,
  changed: string | Buffer,
  mode: number,
) {
  const f = await preparationFixture(() => "");
  const renames = {
    [old]: moved,
    ...(["multi", "squashed"].includes(landing)
      ? { "second.md": "done/second.md" }
      : {}),
  };
  // Both spellings exist, but only the exact destination receives the change.
  await mkdir(join(f.root, "done"));
  await writeFile(join(f.root, moved.replace("new", "n ew")), "unrelated\n");
  for (const path of [old, "second.md"]) {
    await writeFile(join(f.root, path), initial);
  }
  f.git("add", ".");
  f.git("commit", "-qm", "original paths");
  const base = f.git("rev-parse", "HEAD");
  f.git("worktree", "add", "--detach", f.worktree, base);
  for (const path of Object.keys(renames)) {
    await writeFile(join(f.worktree, path), changed);
    await chmod(join(f.worktree, path), mode);
    f.git("-C", f.worktree, "commit", "-qam", `candidate ${path}`);
  }
  const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
  for (const [from, to] of Object.entries(renames)) f.git("mv", from, to);
  f.git("commit", "-qm", "upstream path move");
  const movedBase = f.git("rev-parse", "HEAD");
  for (const path of Object.values(renames)) {
    await writeFile(join(f.root, path), changed);
    await chmod(join(f.root, path), mode);
    if (landing !== "squashed") f.git("commit", "-qam", "land candidate hunk");
  }
  if (landing === "squashed") f.git("commit", "-qam", "squash candidate");
  const commit = f.git("rev-parse", "HEAD");
  const branch = f.git("branch", "--show-current");
  f.git("remote", "add", "origin", f.root);
  f.git("update-ref", `refs/remotes/origin/${branch}`, commit);
  f.git("branch", `--set-upstream-to=origin/${branch}`, branch);
  return { f, renames, base, revision, movedBase, commit, branch };
}

test.each(
  [
    { landing: "single", old: "old.md", moved: "done/new.md" },
    { landing: "multi", old: 'old space é"\t.md', moved: 'done/new é"\t.md' },
    { landing: "squashed", old: "old.md", moved: "done/new.md" },
    { landing: "binary", old: "old.bin", moved: "done/new.bin" },
    { landing: "mode", old: "old.sh", moved: "done/new.sh" },
    { landing: "trailing-space", old: "old.md", moved: "done/new.md" },
    { landing: "trailing-tab", old: "old.md", moved: "done/new.md" },
  ].flatMap((scenario) =>
    ["record-landing", "record-merge"].map((action) => ({
      action,
      ...scenario,
      initial: scenario.landing.startsWith("trailing-")
        ? 'text = """\nbefore\n"""\n'
        : scenario.landing === "binary"
          ? Buffer.from([0, 1, 2, 3])
          : "before\n-- a/old.md\n++ b/old.md\nafter\n",
      changed:
        new Map<string, string | Buffer>([
          ["trailing-space", 'text = """\nhello \n"""\n'],
          ["trailing-tab", 'text = """\nhello\t\n"""\n'],
          ["binary", Buffer.from([0, 4, 5, 6])],
          ["mode", "before\n-- a/old.md\n++ b/old.md\nafter\n"],
        ]).get(scenario.landing) ??
        "before\n--- a/old.md\n+++ b/old.md\nafter\n",
      drift: scenario.landing.startsWith("trailing-")
        ? 'text = """\nhello\n"""\n'
        : scenario.landing === "binary"
          ? Buffer.from([0, 7, 8, 9])
          : "before\n--- a/o ld.md\n+++ b/old.md\nafter\n",
      mode: scenario.landing === "mode" ? 0o755 : 0o644,
    })),
  ),
)(
  "$action proves explicit path renames ($landing)",
  async ({ action, landing, old, moved, initial, changed, drift, mode }) => {
    const { f, renames, base, revision, movedBase, commit, branch } =
      await renamedCandidateFixture(
        landing,
        old,
        moved,
        initial,
        changed,
        mode,
      );
    const engine = f.factory();
    const storage = openPersistence(engine.directory, []);
    storage.commit(
      {
        enabled: false,
        owner: "T-owner",
        runs: {
          A:
            action === "record-merge"
              ? {
                  kind: "done",
                  thread: "T-prepared",
                  revision,
                  acceptedBase: base,
                  attempt: 1,
                  insight: "accepted",
                  acceptedAt: Date.parse("2026-11-25T00:00:00.000Z"),
                }
              : {
                  kind: "blocked",
                  thread: "T-prepared",
                  reason: "Target changed",
                  incident: {
                    id: "rename-stop",
                    ticket: "A",
                    owner: "T-owner",
                    base,
                    attempt: 1,
                    reason: "target-changed",
                    recovery: "inspect",
                    delivery: "sent",
                  },
                },
        },
      },
      "A",
      "fixture",
      "candidate waiting for landing proof",
    );
    storage.close();
    const accepted = factoryStatus(engine.directory).runs.A;
    f.host.state = async () => {
      throw new Error("Recording must not observe threads");
    };
    const request = {
      ticket: "A",
      revision: action === "record-merge" ? base : revision,
      commit,
      pr: 97,
      incident: "rename-stop",
      decision: "Owner approved exact upstream path moves",
      renames,
    };
    f.host.readPullRequest = () => ({
      state: "MERGED",
      merge: commit,
      head: revision,
      checks: [
        { __typename: "StatusContext", context: "quality", state: "SUCCESS" },
      ],
    });
    const record = (input: unknown, restart = false) => {
      const current = restart ? f.factory() : engine;
      return action === "record-merge"
        ? current.recordMerge(input, "T-owner")
        : current.recordLanding(input, "T-owner");
    };
    const statePath = join(engine.directory, "state.sqlite");
    const before = await readFile(statePath);
    for (const invalid of [
      undefined,
      {},
      null,
      [],
      "old.md",
      { [old]: 1 },
      { [old]: old },
      { ...renames, [old]: "wrong.md" },
      { ...renames, [old]: moved.replace("new", "n ew") },
      { ...renames, absent: "elsewhere.md" },
      { ...renames, "": "empty-source.md" },
      { ...renames, [old]: "../outside.md" },
      { ...renames, [old]: "/absolute.md" },
      { ...renames, "second.md": moved },
      Object.fromEntries(Object.entries(renames).slice(0, -1)),
    ]) {
      expect(
        await record({ ...request, renames: invalid }).catch(() => "refused"),
      ).toBe("refused");
      expect(await readFile(statePath)).toEqual(before);
    }
    // A separate landing with drift, not one after the correct patch already landed.
    f.git("checkout", "-q", "--detach", movedBase);
    await writeFile(join(f.root, moved), drift);
    f.git("commit", "-qam", "wrong landing content");
    const wrong = f.git("rev-parse", "HEAD");
    f.git("update-ref", `refs/remotes/origin/${branch}`, wrong);
    f.git("checkout", "-q", branch);
    f.git("reset", "--hard", wrong);
    expect(
      await record({ ...request, commit: wrong }).catch(() => "refused"),
    ).toBe("refused");
    expect(await readFile(statePath)).toEqual(before);
    f.git("reset", "--hard", commit);
    // A locally available commit is not proof until the fetched upstream contains it.
    f.git("update-ref", `refs/remotes/origin/${branch}`, movedBase);
    expect(await record(request).catch(() => "refused")).toBe("refused");
    expect(await readFile(statePath)).toEqual(before);
    f.git("update-ref", `refs/remotes/origin/${branch}`, commit);
    const landed = await record(request);
    expect(landed).toMatchObject({
      enabled: false,
      runs: { A: { kind: "done", revision, merge: { pr: 97, commit } } },
    });
    if (action === "record-merge") {
      if (accepted?.kind !== "done") throw new Error("Expected accepted run");
      expect(landed.runs.A).toEqual({
        ...accepted,
        stageAt: expect.any(Number),
        merge: {
          pr: 97,
          commit,
          at: expect.any(String),
          evidence: {
            head: revision,
            checks: [
              {
                __typename: "StatusContext",
                context: "quality",
                state: "SUCCESS",
              },
            ],
            exception: {
              decision: request.decision,
              reason: expect.stringContaining("two parents"),
            },
          },
        },
      });
    }
    const after = await readFile(statePath);
    expect(await record(request, true)).toEqual(landed);
    expect(
      await record(
        {
          ...request,
          renames: Object.fromEntries(Object.entries(renames).reverse()),
        },
        true,
      ),
    ).toEqual(landed);
    expect(await readFile(statePath)).toEqual(after);
    const records = openPersistence(engine.directory, []);
    if (action === "record-landing")
      expect(JSON.parse(records.lastEvent("A", "landed-outside")!)).toEqual(
        request,
      );
    else
      expect(JSON.parse(records.lastEvent("A", "merge-recorded")!)).toEqual({
        commit,
        renames,
      });
    records.close();
    for (const conflict of [
      { renames: { ...renames, extra: "other" } },
      { renames: undefined },
      { renames: {} },
      { pr: 98 },
      { commit: wrong },
    ]) {
      expect(
        await record({ ...request, ...conflict }, true).catch(String),
      ).toContain("Conflicting");
      expect(await readFile(statePath)).toEqual(after);
    }
    expect(await readFile(statePath)).toEqual(after);
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  },
);

async function externalLandingFixture(targetChanged = false) {
  const f = await preparationFixture(() => "");
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([
      { id: "A", brief: "First", after: [] },
      { id: "B", brief: "Dependent", after: ["A"] },
    ]),
  );
  const configPath = join(f.root, ".factory.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, verify: targetChanged ? "true" : "false" }),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "dependent ticket");
  const engine = f.factory();
  const started = await engine.tick("start", "T-owner");
  const running = started.runs.A;
  if (running?.kind !== "running") throw new Error("Expected worker");
  await mkdir(join(f.worktree, "src"));
  await writeFile(join(f.worktree, "src/value"), "landed change\n");
  const workerGit = (...args: string[]) =>
    execFileSync("git", ["-C", f.worktree, ...args], {
      encoding: "utf8",
    }).trim();
  workerGit("add", ".");
  workerGit("commit", "-qm", "candidate");
  const revision = workerGit("rev-parse", "HEAD");
  const report = {
    attempt: running.attempt,
    kind: "candidate",
    revision,
    insight: "Verified candidate",
  };
  const reportPath = join(engine.directory, "A.report.json");
  await writeFile(reportPath, JSON.stringify(report));
  f.host.state = async () => "idle";
  if (targetChanged) {
    // A rewritten target no longer descends from the base, so it cannot be rebased onto.
    f.git(
      "commit",
      "--amend",
      "--allow-empty",
      "-qm",
      "rewrite integration target",
    );
  } else {
    const repair = await engine.tick("reconcile", "T-owner");
    expect(repair.runs.A).toMatchObject({ kind: "running", attempt: 2 });
    await writeFile(
      reportPath,
      JSON.stringify({ attempt: 2, kind: "blocked", reason: "Worker stopped" }),
    );
  }
  const stopped = await engine.tick("reconcile", "T-owner");
  const blocked = stopped.runs.A;
  if (blocked?.kind !== "blocked" || !blocked.incident)
    throw new Error("Expected current incident");
  if (targetChanged) {
    expect(blocked.checkpoint).toBeUndefined();
    expect(blocked.repair).toBeUndefined();
    expect(blocked.incident).toMatchObject({
      base: running.base,
      attempt: 1,
      reason: "target-changed",
      recovery: "inspect",
    });
    expect(blocked.incident.cause).toBeUndefined();
    expect(f.notices.at(-1)).toContain("Reason: target-changed.");
    expect(f.notices.at(-1)).not.toContain("Causing");
  } else {
    expect(blocked.checkpoint).toMatchObject({
      base: running.base,
      attempt: 2,
    });
    expect(blocked.incident.reason).toBe("worker-blocked");
  }
  expect(stopped.runs.B).toBeUndefined();
  expect(
    await engine
      .recordMerge({ ticket: "A", pr: 51, commit: revision }, "T-owner")
      .catch(String),
  ).toContain("done ticket");

  f.git("merge", "--no-ff", "-qm", "outside merge", revision);
  const commit = f.git("rev-parse", "HEAD");
  const branch = f.git("branch", "--show-current");
  f.git("remote", "add", "origin", f.root);
  f.git("update-ref", `refs/remotes/origin/${branch}`, commit);
  f.git("branch", `--set-upstream-to=origin/${branch}`, branch);
  const request = {
    ticket: "A",
    incident: blocked.incident.id,
    revision,
    pr: 51,
    commit,
    decision: "Operator approved the external gate and review",
  };
  const snapshot = async () => ({
    state: factoryStatus(engine.directory),
    events: factoryEvents(engine.directory),
    bytes: await readFile(join(engine.directory, "state.sqlite")),
  });
  return {
    f,
    engine,
    running,
    stopped,
    revision,
    commit,
    branch,
    request,
    snapshot,
  };
}

test.each([false, true])(
  "external landing rejects stale incidents, unproven candidates and active repairs without writes (target changed %s)",
  async (targetChanged) => {
    const { f, engine, running, stopped, commit, branch, request, snapshot } =
      await externalLandingFixture(targetChanged);
    const before = await snapshot();
    for (const invalid of [
      { ticket: "missing" },
      { incident: "stale" },
      { decision: " " },
      { revision: "main" },
      { revision: commit },
      { pr: 0 },
      { commit: "main" },
      { commit: running.base },
    ]) {
      expect(
        await engine
          .recordLanding({ ...request, ...invalid }, "T-owner")
          .catch(() => "refused"),
      ).toBe("refused");
      expect(await snapshot()).toEqual(before);
    }
    for (const owner of [undefined, "T-prepared", "T-stranger"] as const) {
      expect(
        await engine.recordLanding(request, owner).catch(() => "refused"),
      ).toBe("refused");
      expect(await snapshot()).toEqual(before);
    }
    f.git("update-ref", `refs/remotes/origin/${branch}`, running.base);
    expect(
      await engine.recordLanding(request, "T-owner").catch(() => "refused"),
    ).toBe("refused");
    expect(await snapshot()).toEqual(before);
    f.git("update-ref", `refs/remotes/origin/${branch}`, commit);
    const previous = f.git("rev-parse", `${running.base}^`);
    f.git(
      "restore",
      "--source",
      previous,
      "--",
      "tickets.json",
      ".factory.json",
    );
    f.git("commit", "-qam", "restore pre-base configuration");
    const reversed = f.git("rev-parse", "HEAD");
    f.git("update-ref", `refs/remotes/origin/${branch}`, reversed);
    expect(
      await engine
        .recordLanding(
          { ...request, revision: previous, commit: reversed },
          "T-owner",
        )
        .catch(() => "refused"),
    ).toBe("refused");
    expect(await snapshot()).toEqual(before);

    for (const run of [
      running,
      { kind: "uncertain" as const, thread: running.thread, reason: "held" },
      { ...running, delivery: "queued" as const },
      { ...running, delivery: "sending" as const },
    ]) {
      const storage = openPersistence(engine.directory, []);
      storage.commit({ ...stopped, runs: { A: run } }, "A", "fixture", "held");
      storage.close();
      const held = await snapshot();
      expect(
        await engine.recordLanding(request, "T-owner").catch(() => "refused"),
      ).toBe("refused");
      expect(await snapshot()).toEqual(held);
    }
  },
);

test("checkpoint-less landing requires durable identity and the registered worker worktree", async () => {
  const { f, engine, stopped, request, snapshot } =
    await externalLandingFixture(true);
  const blocked = stopped.runs.A;
  if (blocked?.kind !== "blocked" || !blocked.incident)
    throw new Error("Expected current incident");
  const path = join(engine.directory, "state.sqlite");
  for (const invalid of [
    { ...blocked, thread: undefined },
    { ...blocked, incident: undefined },
    ...[
      { base: undefined },
      { base: "unknown" },
      { attempt: undefined },
      { attempt: 0 },
      { owner: "T-stranger" },
      { ticket: "B" },
    ].map((fields) => ({
      ...blocked,
      incident: { ...blocked.incident, ...fields },
    })),
  ]) {
    const db = new Database(path);
    db.query("UPDATE runs SET data=? WHERE ticket='A'").run(
      JSON.stringify(invalid),
    );
    db.close();
    const before = await readFile(path);
    expect(
      await engine.recordLanding(request, "T-owner").catch(() => "refused"),
    ).toBe("refused");
    expect(await readFile(path)).toEqual(before);
  }
  const db = new Database(path);
  db.query("UPDATE runs SET data=? WHERE ticket='A'").run(
    JSON.stringify(blocked),
  );
  db.close();
  const before = await snapshot();
  f.git("worktree", "move", f.worktree, `${f.worktree}-moved`);
  f.git("clone", "-q", "--no-hardlinks", f.root, f.worktree);
  expect(
    await engine.recordLanding(request, "T-owner").catch(String),
  ).toContain("not the registered worker worktree");
  expect(await snapshot()).toEqual(before);
});

test("external landing preserves saved repair identity while paused", async () => {
  const { f, engine, stopped, running, request, snapshot } =
    await externalLandingFixture();
  const blocked = stopped.runs.A;
  if (blocked?.kind !== "blocked" || !blocked.checkpoint)
    throw new Error("Expected worker checkpoint");
  const storage = openPersistence(engine.directory, []);
  storage.commit(
    {
      ...stopped,
      runs: {
        A: { ...blocked, repair: blocked.checkpoint, checkpoint: undefined },
      },
    },
    "A",
    "fixture",
    "saved repair",
  );
  storage.close();
  await engine.tick("pause", "T-owner");
  const counts = f.counts();
  const before = await snapshot();
  expect(
    await engine
      .recordLanding(
        { ...request, renames: { "src/value": "src/value" } },
        "T-owner",
      )
      .catch(() => "refused"),
  ).toBe("refused");
  expect(await snapshot()).toEqual(before);
  const landed = await engine.recordLanding(request, "T-owner");
  expect(landed.enabled).toBe(false);
  expect(landed.runs.A).toMatchObject({
    kind: "done",
    thread: running.thread,
    acceptedBase: running.base,
    revision: request.revision,
    merge: { pr: request.pr, commit: request.commit },
    workerModel: "openai/gpt-6.2-sol",
  });
  expect(f.counts()).toEqual(counts);
  const after = await snapshot();
  expect(
    await f.factory().recordLanding({ ...request, renames: {} }, "T-owner"),
  ).toEqual(landed);
  expect(await snapshot()).toEqual(after);
});

test("a ticket parked at the attempt cap records its external landing", async () => {
  const { f, engine, stopped, running, request } =
    await externalLandingFixture();
  const blocked = stopped.runs.A;
  if (
    blocked?.kind !== "blocked" ||
    !blocked.checkpoint ||
    !blocked.thread ||
    !blocked.incident
  )
    throw new Error("Expected worker checkpoint");
  // The same worker checkpoint, as the cap leaves it after a fourth rejection.
  const storage = openPersistence(engine.directory, []);
  storage.commit(
    {
      ...stopped,
      runs: {
        A: {
          kind: "parked",
          definition: blocked.definition,
          thread: blocked.thread,
          reason: blocked.reason,
          repair: { ...blocked.checkpoint, attempt: 4 },
          executor: blocked.executor,
          incident: {
            ...blocked.incident,
            reason: "verification-rejected",
            recovery: "resume",
            attempt: 4,
          },
        },
      },
    },
    "A",
    "fixture",
    "parked at cap",
  );
  storage.close();
  const counts = f.counts();
  const landed = await engine.recordLanding(request, "T-owner");
  expect(landed.runs.A).toMatchObject({
    kind: "done",
    thread: running.thread,
    revision: request.revision,
    merge: { pr: request.pr, commit: request.commit },
  });
  expect(f.counts()).toEqual(counts);
});

test.each([false, true])(
  "external landing survives reload and releases dependencies only on reconciliation (target changed %s)",
  async (targetChanged) => {
    const { f, engine, running, revision, commit, request, snapshot } =
      await externalLandingFixture(targetChanged);
    const counts = f.counts();
    f.git("reset", "--hard", running.base);
    const blocked = await snapshot();
    expect(
      await engine.recordLanding(request, "T-owner").catch(String),
    ).toContain("Integrate the fetched upstream into the root checkout first");
    expect(await snapshot()).toEqual(blocked);
    f.git("merge", "--ff-only", commit);
    const landed = await engine.recordLanding(request, "T-owner");
    expect(landed).toMatchObject({
      enabled: true,
      runs: {
        A: {
          kind: "done",
          thread: running.thread,
          revision,
          acceptedBase: running.base,
          merge: { pr: 51, commit },
          insight: request.decision,
        },
      },
    });
    expect(landed.runs.A?.incident).toBeUndefined();
    expect(landed.runs.B).toBeUndefined();
    expect(f.counts()).toEqual(counts);
    const after = await snapshot();
    const reloaded = f.factory();
    expect(await reloaded.recordLanding(request, "T-owner")).toEqual(landed);
    expect(await snapshot()).toEqual(after);
    for (const conflict of [
      { pr: 52 },
      { commit: revision },
      { incident: "old" },
      { revision: commit },
    ]) {
      expect(
        await reloaded
          .recordLanding({ ...request, ...conflict }, "T-owner")
          .catch(String),
      ).toContain("Conflicting");
      expect(await snapshot()).toEqual(after);
    }
    expect(
      factoryEvents(engine.directory)?.filter(
        (event) => event.action === "landed-outside",
      ),
    ).toHaveLength(1);
    f.host.state = async () => "running";
    const next = await reloaded.tick("reconcile", "T-owner");
    expect(next.runs.B).toMatchObject({ kind: "running", base: commit });
  },
);

test("provider reclassification cannot restore a second implementation owner", async () => {
  const f = await preparationFixture(() => "");
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([
      { id: "A", brief: "First", after: [] },
      { id: "B", brief: "Second", after: [] },
    ]),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "two tickets");
  let creates = 0;
  f.host.create = async () => (++creates === 1 ? "T-A" : "T-B");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const { tools } = watchdogFixture();
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  f.host.state = async (thread) => (thread === "T-A" ? "error" : "running");
  const blocked = await engine.tick("reconcile", "T-owner");
  expect(blocked.runs.A).toMatchObject({
    kind: "blocked",
    incident: { reason: "worker-error", recovery: "resume" },
  });
  expect(blocked.runs.B).toMatchObject({ kind: "running", thread: "T-B" });
  f.host.state = async (thread) =>
    thread === "T-A"
      ? {
          kind: "provider-limit",
          limit: { message: "Limit", observedAt: 1000, resetAt: 2000 },
        }
      : "running";
  const connected = await engine.tick(
    "reconcile",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(connected.runs.A).toMatchObject({
    kind: "blocked",
    incident: { reason: "worker-error", recovery: "resume" },
  });
  expect(connected.runs.B).toMatchObject({ kind: "running", thread: "T-B" });
  expect(creates).toBe(2);
});

test("invalid limit policies fail before worker creation", async () => {
  const f = await preparationFixture(() => "");
  const path = join(f.root, ".factory.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  for (const providerLimit of [
    null,
    "fallback",
    {},
    { mode: "other" },
    { mode: "wait", reviewerModel: "anthropic/claude-sonnet-4-6" },
    { mode: "fallback" },
    { mode: "fallback", reviewerModel: "openai/gpt-6-astra" },
    { mode: "fallback", reviewerModel: "missing-provider" },
    { mode: "fallback", reviewerModel: " anthropic/claude-sonnet-4-6" },
    {
      mode: "fallback",
      reviewerModel: "anthropic/claude-sonnet-4-6",
      workerModel: "bad",
    },
    {
      mode: "fallback",
      reviewerModel: "anthropic/claude-sonnet-4-6",
      unknown: true,
    },
  ]) {
    await writeFile(path, JSON.stringify({ ...raw, providerLimit }));
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
      /providerLimit/,
    );
  }
  await writeFile(
    path,
    JSON.stringify({
      ...raw,
      workerModel: "anthropic/claude-fable-5-2",
      providerLimit: {
        mode: "fallback",
        reviewerModel: "anthropic/claude-sonnet-4-6",
      },
    }),
  );
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow(/providerLimit/);
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test.each([
  ["openai/gpt-6.2-sol", "openai/gpt-6.2-astra"],
  ["anthropic/claude-fable-5-2", "openai/gpt-6.2-astra"],
  ["moonshotai/kimi-k3", "openai/gpt-6.2-astra"],
  ["openai/gpt-6.2-sol", "openrouter/openai/gpt-6-astra"],
  ["anthropic/claude-fable-5-2", "amp/claude-fable-5-2"],
  ["anthropic/claude-fable-5-2", "fireworks-ai/claude-fable-5-2"],
  ["openai/gpt-6.2-sol", "baseten/openai/gpt-6-astra"],
  ["openai/gpt-6.2-sol", "google-vertex/claude-fable-5-2"],
  ["openrouter/openai/gpt-6.2-sol", "anthropic/claude-fable-5-2"],
] as const)(
  "unsafe fallback models %s / %s fail authored and stored validation before creation",
  async (workerModel, reviewerModel) => {
    const f = await preparationFixture(() => "");
    const path = join(f.root, ".factory.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    const config = await configuration(f.root);
    const providerLimit = { mode: "fallback", reviewerModel } as const;
    await writeFile(
      path,
      JSON.stringify({ ...raw, workerModel, providerLimit }),
    );
    f.git("add", ".factory.json");
    f.git("commit", "-qm", "routed model definition");
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
      /providerLimit/,
    );
    await writeFile(path, JSON.stringify(raw));
    f.git("add", ".factory.json");
    f.git("commit", "-qm", "restore first-party definition");
    const engine = f.factory();
    const storage = openPersistence(engine.directory, []);
    try {
      storage.definition({ ...config, workerModel, providerLimit }, true);
    } finally {
      storage.close();
    }
    expect(() => factoryDefinition(engine.directory)).toThrow(
      "Invalid stored definition",
    );
    expect(() => factoryDefinition(engine.directory, config.digest)).toThrow(
      "Invalid stored definition",
    );
    expect(engine.tick("start", "T-owner")).rejects.toThrow(
      "Invalid stored definition",
    );
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  },
);

test.each([undefined, "google/gemini-2.5-pro"])(
  "worker fallback %s waits on the same thread when the API cannot switch models",
  async (workerModel) => {
    const f = await preparationFixture(() => "");
    const path = join(f.root, ".factory.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...raw,
        providerLimit: {
          mode: "fallback",
          reviewerModel: "anthropic/claude-sonnet-4-6",
          workerModel,
        },
      }),
    );
    f.git("add", ".");
    f.git("commit", "-qm", "fallback fixture");
    let at = 1000;
    const engine = f.factory(() => at);
    await engine.tick("start", "T-owner");
    f.host.state = async () => ({
      kind: "provider-limit",
      limit: { message: "Usage limit", observedAt: 1000, resetAt: 2000 },
    });
    const waiting = (await engine.tick("reconcile")).runs.A!;
    expect(waiting).toMatchObject({
      kind: "running",
      thread: "T-prepared",
      workerModel: "openai/gpt-6.2-sol",
      incident: { reason: "provider-limit", recovery: "wait" },
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    at = 2000;
    await engine.tick("reconcile");
    const reopened = f.factory(() => at);
    const continued = (await reopened.tick("reconcile")).runs.A!;
    expect(continued).toMatchObject({
      kind: "running",
      thread: "T-prepared",
      workerModel: "openai/gpt-6.2-sol",
      attempt: 1,
      incident: { providerLimit: { continuation: { outcome: "sent" } } },
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 2 });
  },
);

test("a held provider continuation becomes an ordinary watchdog stall", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const engine = f.factory(() => at);
  await engine.tick("start", "T-owner");
  f.host.state = async () => ({
    kind: "provider-limit",
    limit: { message: "Limit", observedAt: at },
  });
  const sent: string[] = [];
  f.host.send = async (thread) => {
    sent.push(thread);
    if (thread !== "T-owner") throw new Error("Unknown continuation delivery");
  };
  await engine.tick("reconcile");
  at += 1_800_000;
  const continued = (await engine.tick("reconcile")).runs.A!;
  expect(continued.incident?.providerLimit?.continuation?.outcome).toBe(
    "unknown",
  );
  at += 1_800_000;
  const stalled = (await engine.tick("reconcile")).runs.A!;
  expect(stalled.watchdog?.alerts).toContainEqual(
    expect.objectContaining({ kind: "unresolved" }),
  );
  expect(sent.filter((thread) => thread === "T-prepared")).toHaveLength(1);
  expect(sent).toContain("T-owner");
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({
      attempt: 1,
      kind: "blocked",
      reason: "Needs a decision",
    }),
  );
  f.host.state = async () => "idle";
  const disconnected = createFactory(f.root, f.host, openStore, () => at);
  const settled = (await disconnected.tick("reconcile", "T-owner")).runs.A!;
  expect(settled).toMatchObject({
    kind: "blocked",
    reason: "Needs a decision",
    incident: { reason: "worker-blocked", recovery: "resume" },
  });
  expect(sent.filter((thread) => thread === "T-prepared")).toHaveLength(1);
});

test.each([
  ["error", "worker-error"],
  ["awaiting-approval", "approval-required"],
] as const)(
  "provider wait yielding to %s records a stop, not recovery",
  async (activity, reason) => {
    const f = await preparationFixture(() => "");
    let at = 1000;
    const engine = f.factory(() => at);
    await engine.tick("start", "T-owner");
    f.host.state = async () => ({
      kind: "provider-limit",
      limit: { message: "Limit", observedAt: at, resetAt: 2000 },
    });
    await engine.tick("reconcile");
    at = 2000;
    await engine.tick("reconcile");
    f.host.state = async () => activity;
    const stopped = (await engine.tick("reconcile")).runs.A!;
    expect(stopped).toMatchObject({
      kind: "blocked",
      incident: { reason, cause: { role: "worker", thread: "T-prepared" } },
    });
    const db = new Database(join(engine.directory, "state.sqlite"), {
      readonly: true,
    });
    try {
      const actions = db
        .query<{ action: string }, []>(
          "SELECT action FROM events WHERE ticket = 'A'",
        )
        .all()
        .map(({ action }) => action);
      expect(actions).toContain("provider-continuation-sent");
      expect(actions).toContain("blocked");
      expect(actions).not.toContain("provider-recovered");
    } finally {
      db.close();
    }
  },
);

test("planned intake survives refresh and restart without dispatch until owner admission", async () => {
  const f = await preparationFixture(() => "");
  const planned = [
    { id: "B", brief: "PRIVATE-CANARY", after: [] },
    {
      id: "A",
      brief: "PRIVATE-CANARY",
      after: ["B"],
      intake: "planned",
      outcome: "Safe outcome",
    },
    {
      id: "C",
      brief: "PRIVATE-CANARY",
      after: ["A"],
      intake: "planned",
      outcome: "Later outcome",
    },
  ];
  for (const intake of ["admitted", "queued", null])
    expect(() => tasks([{ ...planned[1], after: [], intake }])).toThrow();
  expect(() =>
    tasks([{ ...planned[1], after: [], outcome: undefined }]),
  ).toThrow();
  const path = join(f.root, "tickets.json");
  await writeFile(path, JSON.stringify(planned));
  f.git("add", ".");
  f.git("commit", "-qm", "plan");
  const engine = createFactory(f.root, f.host, openStore);
  const storage = openPersistence(engine.directory, []);
  storage.commit(
    {
      enabled: false,
      owner: "T-owner",
      runs: {
        B: {
          kind: "done",
          revision: f.git("rev-parse", "HEAD"),
          thread: "T-old",
          insight: "PRIVATE-CANARY",
        },
      },
    },
    "B",
    "accepted",
    "fixture",
  );
  storage.close();
  const { tools } = watchdogFixture();
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  await writeFile(
    path,
    JSON.stringify([
      planned[0],
      { id: "A", brief: "PRIVATE-CANARY", after: ["B"] },
      planned[2],
    ]),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "refresh without intake");
  await engine.tick("reload", "T-owner");
  await migrateDefinition(f.root);
  f.git("add", ".");
  f.git("commit", "-qm", "migrate definition");
  const restarted = createFactory(f.root, f.host, openStore);
  const plannedOnly = await restarted.tick(
    "reconcile",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(plannedOnly.monitor?.schedule).toBe("cleared");
  const server = startDashboard({ root: f.root, port: 0 });
  try {
    const bytes = await readFile(join(engine.directory, "state.sqlite"));
    const response = await fetch(`http://localhost:${server.port}/api/status`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.counts).toEqual({ planned: 2, queued: 0, accepted: 1 });
    expect(
      body.tasks.find((task: { id: string }) => task.id === "A"),
    ).toMatchObject({ id: "A", stage: "planned", outcome: "Safe outcome" });
    expect(
      body.tasks.find((task: { id: string }) => task.id === "B").outcome,
    ).toBe(null);
    expect(JSON.stringify(body)).not.toContain("PRIVATE-CANARY");
    expect(await readFile(join(engine.directory, "state.sqlite"))).toEqual(
      bytes,
    );
    for (const owner of [undefined, "T-stranger", "T-old"] as const)
      expect(
        restarted.tick("admit", owner, f.host.state, undefined, undefined, "A"),
      ).rejects.toThrow();
    expect(
      restarted.tick(
        "admit",
        "T-owner",
        f.host.state,
        undefined,
        undefined,
        "C",
      ),
    ).rejects.toThrow("accepted prerequisites");
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    await restarted.tick("pause", "T-owner");
    await restarted.tick(
      "admit",
      "T-owner",
      f.host.state,
      undefined,
      undefined,
      "A",
    );
    await restarted.tick(
      "admit",
      "T-owner",
      f.host.state,
      undefined,
      undefined,
      "A",
    );
    expect((await restarted.tick("status")).enabled).toBe(false);
    const admitted = await (
      await fetch(`http://localhost:${server.port}/api/status`)
    ).json();
    expect(admitted.counts).toEqual({ planned: 1, queued: 1, accepted: 1 });
    await restarted.tick("reload", "T-owner");
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    const working = await restarted.tick(
      "start",
      "T-owner",
      f.host.state,
      undefined,
      tools,
    );
    expect(working.monitor?.schedule).toBe("installed");
    await restarted.tick(
      "admit",
      "T-owner",
      f.host.state,
      undefined,
      undefined,
      "A",
    );
    const state = await createFactory(f.root, f.host, openStore).tick(
      "reconcile",
      "T-owner",
    );
    expect(state.runs.A).toMatchObject({
      kind: "running",
      thread: "T-prepared",
      attempt: 1,
    });
    expect(state.runs.B).toMatchObject({ kind: "done", thread: "T-old" });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    await mkdir(join(f.worktree, "src"));
    await writeFile(join(f.worktree, "src/value"), "accepted planned work");
    f.git("-C", f.worktree, "add", "src/value");
    f.git("-C", f.worktree, "commit", "-qm", "candidate");
    const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision,
        insight: "Verified planned intake",
      }),
    );
    f.host.state = async () => "idle";
    const accepted = await restarted.tick("reconcile", "T-owner");
    expect(accepted.runs.A).toMatchObject({
      kind: "done",
      revision,
      thread: "T-prepared",
    });
    const completed = await restarted.tick(
      "reconcile",
      "T-owner",
      f.host.state,
      undefined,
      tools,
    );
    expect(completed.enabled).toBe(true);
    expect(completed.monitor?.schedule).toBe("cleared");
    const final = await (
      await fetch(`http://localhost:${server.port}/api/status`)
    ).json();
    expect(final.counts).toEqual({ planned: 1, queued: 0, accepted: 2 });
    expect(
      final.tasks.find((task: { id: string }) => task.id === "A"),
    ).toMatchObject({ stage: "accepted", outcome: "Safe outcome", revision });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
  } finally {
    await server.stop();
  }
});

// A ticket file fixture with asymmetric steps: the second label holds a colon and an arrow, and
// the Status and Approach sections carry private canary text that must never cross.
function ticketFileText(h1: string, outcome: string, secondStep: string) {
  return `# ${h1}

## Status

- Goal: CANARY goal text that must stay in the file.
- Outcome: ${outcome}
- intake: admitted

## Approach

CANARY approach text reaches neither status nor the feed.

## Steps

1. **Read ticket files**. Add the pure reader and its walker.
2. **${secondStep}**. Prove the precedence rule both ways.
3. **Sweep vanished rows**. Remove runless planned rows only.

## Test plan

- Run the full gate.
`;
}

test("ticket file reader extracts public planning fields only", () => {
  const path = "docs/feats/beta/F101-alone.md";
  const content = ticketFileText(
    "F101-alone",
    "Saved tickets appear as planned",
    "Merge: queue wins → file yields",
  );
  const read = readTicketFile(path, content);
  expect(read).toEqual({
    id: "F101-alone",
    steps: [
      "Read ticket files",
      "Merge: queue wins → file yields",
      "Sweep vanished rows",
    ],
    outcome: "Saved tickets appear as planned",
  });
  expect(JSON.stringify(read)).not.toContain("CANARY");
  expect(read).not.toHaveProperty("intake");
  expect(
    readTicketFile(path, ticketFileText("F999-renamed", "x", "y")),
  ).toEqual({ skip: "H1 does not match the file name" });
  expect(
    readTicketFile(
      path,
      content.replace("- Outcome: Saved tickets appear as planned\n", ""),
    ),
  ).toEqual({ skip: "no Outcome line under ## Status" });
  expect(readTicketFile(path, content.replace(/\*\*/g, ""))).toEqual({
    skip: "no bold step labels under ## Steps",
  });
  expect(
    readTicketFile("docs/feats/done/F101-alone.md", content),
  ).toBeUndefined();
  expect(readTicketFile("docs/feats/beta/notes.md", content)).toBeUndefined();
  expect(
    readTicketFile("docs/feats/beta/F1011-four-digits.md", content),
  ).toBeUndefined();
});

test("ticket files sync to planned rows on reload and reconcile, queue first", async () => {
  const f = await preparationFixture(() => "");
  const raw = await Bun.file(join(f.root, ".factory.json")).json();
  raw.ticketFiles = "docs/feats";
  await writeFile(join(f.root, ".factory.json"), JSON.stringify(raw));
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([
      { id: "A", brief: "Work", after: [] },
      {
        id: "F100-queued",
        brief: "Foreman private brief",
        after: ["A"],
        intake: "planned",
        outcome: "Authored outcome",
        steps: ["Stale hand copy"],
        size: "small",
        risky: true,
      },
    ]),
  );
  const feats = join(f.root, "docs/feats");
  await mkdir(join(feats, "alpha"), { recursive: true });
  await mkdir(join(feats, "beta"), { recursive: true });
  await mkdir(join(feats, "done"), { recursive: true });
  await writeFile(
    join(feats, "alpha/F100-queued.md"),
    ticketFileText("F100-queued", "File outcome", "File step two"),
  );
  await writeFile(
    join(feats, "beta/F101-alone.md"),
    ticketFileText(
      "F101-alone",
      "Saved tickets appear as planned",
      "Merge: queue wins → file yields",
    ),
  );
  await writeFile(
    join(feats, "beta/F102-broken.md"),
    ticketFileText("F999-renamed", "Unread outcome", "Unread step"),
  );
  await writeFile(
    join(feats, "done/F103-finished.md"),
    ticketFileText("F103-finished", "Done outcome", "Done step"),
  );
  // A dangling symlink is listed but unreadable; it is skipped, never fatal.
  await symlink(
    join(feats, "beta/F109-missing.md"),
    join(feats, "beta/F105-gone.md"),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "ticket files");
  const engine = createFactory(f.root, f.host, openStore);
  await engine.tick("reload", "T-owner");
  const stored = () => {
    const storage = openPersistence(engine.directory, []);
    const rows = Object.fromEntries(
      storage.tickets.map((task) => [task.id, task]),
    );
    storage.close();
    return rows;
  };
  // The merge is field by field: the queue keeps brief, after, intake, size and risky while
  // the ticket file replaces the stale hand-copied steps and outcome.
  expect(stored()["F100-queued"]).toEqual({
    id: "F100-queued",
    brief: "Foreman private brief",
    after: ["A"],
    intake: "planned",
    outcome: "File outcome",
    steps: ["Read ticket files", "File step two", "Sweep vanished rows"],
    size: "small",
    risky: true,
    file: "docs/feats/alpha/F100-queued.md",
  });
  expect(stored()["F101-alone"]).toEqual({
    id: "F101-alone",
    brief: "Implement docs/feats/beta/F101-alone.md",
    after: [],
    intake: "planned",
    outcome: "Saved tickets appear as planned",
    steps: [
      "Read ticket files",
      "Merge: queue wins → file yields",
      "Sweep vanished rows",
    ],
    file: "docs/feats/beta/F101-alone.md",
  });
  expect(stored()["F102-broken"]).toBeUndefined();
  expect(stored()["F103-finished"]).toBeUndefined();
  const status = await engine.tick("status");
  expect(status.skippedTickets).toEqual([
    {
      file: "docs/feats/beta/F102-broken.md",
      reason: "H1 does not match the file name",
    },
    {
      file: "docs/feats/beta/F105-gone.md",
      reason: "unreadable",
    },
  ]);
  expect(JSON.stringify(status)).not.toContain("CANARY");
  expect(JSON.stringify(factoryEvents(engine.directory, 0, 500))).not.toContain(
    "CANARY",
  );
  // A reconcile syncs too: a new file becomes a planned row with no queue edit.
  await writeFile(
    join(feats, "beta/F104-later.md"),
    ticketFileText("F104-later", "Later outcome", "Later step"),
  );
  await engine.tick("reconcile", "T-owner");
  expect(stored()["F104-later"]).toMatchObject({
    intake: "planned",
    outcome: "Later outcome",
  });
  // Deleting the file sweeps the row; the queue file's own row stays.
  await rm(join(feats, "beta/F104-later.md"));
  await engine.tick("reload", "T-owner");
  expect(stored()["F104-later"]).toBeUndefined();
  expect(stored()["F100-queued"]).toMatchObject({ id: "F100-queued" });
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  // Deleting a merged row's file reverts it to the queue file's own entry, stale copy included.
  await rm(join(feats, "alpha/F100-queued.md"));
  await engine.tick("reload", "T-owner");
  expect(stored()["F100-queued"]).toEqual({
    id: "F100-queued",
    brief: "Foreman private brief",
    after: ["A"],
    intake: "planned",
    outcome: "Authored outcome",
    steps: ["Stale hand copy"],
    size: "small",
    risky: true,
  });
});

test("synced rows stay planned on a started factory until the owner admits one", async () => {
  const f = await preparationFixture(() => "");
  const raw = await Bun.file(join(f.root, ".factory.json")).json();
  raw.ticketFiles = "docs/feats";
  await writeFile(join(f.root, ".factory.json"), JSON.stringify(raw));
  await writeFile(join(f.root, "tickets.json"), JSON.stringify([]));
  const feats = join(f.root, "docs/feats/beta");
  await mkdir(feats, { recursive: true });
  await writeFile(
    join(feats, "F101-alone.md"),
    ticketFileText(
      "F101-alone",
      "Saved tickets appear as planned",
      "Merge: queue wins → file yields",
    ),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "ticket files");
  const engine = createFactory(f.root, f.host, openStore);
  const { tools } = watchdogFixture();
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  await engine.tick("reload", "T-owner", f.host.state, undefined, tools);
  await engine.tick("reconcile", "T-owner", f.host.state, undefined, tools);
  const row = () => {
    const storage = openPersistence(engine.directory, []);
    const task = storage.tickets.find((task) => task.id === "F101-alone");
    storage.close();
    return task;
  };
  // The file's authored `- intake: admitted` line produced a planned row and no worker.
  expect(row()).toMatchObject({
    intake: "planned",
    file: "docs/feats/beta/F101-alone.md",
  });
  const state = await engine.tick("status");
  expect(state.runs["F101-alone"]).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain("CANARY");
  expect(JSON.stringify(factoryEvents(engine.directory, 0, 500))).not.toContain(
    "CANARY",
  );
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  // Owner admission works on a synced row, then freezes it against any sync.
  await engine.tick(
    "admit",
    "T-owner",
    f.host.state,
    undefined,
    undefined,
    "F101-alone",
  );
  expect(row()).toMatchObject({ intake: "admitted" });
  const frozen = JSON.stringify(row());
  await writeFile(
    join(feats, "F101-alone.md"),
    ticketFileText("F101-alone", "Changed outcome", "Changed step"),
  );
  await engine.tick("reload", "T-owner", f.host.state, undefined, tools);
  expect(JSON.stringify(row())).toBe(frozen);
  await rm(join(feats, "F101-alone.md"));
  await engine.tick("reload", "T-owner", f.host.state, undefined, tools);
  expect(JSON.stringify(row())).toBe(frozen);
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test("admission uses the loaded ticket path until explicit reload", async () => {
  const f = await preparationFixture(() => "");
  const loaded = {
    id: "A",
    brief: "Loaded private scope",
    after: [],
    intake: "planned",
    outcome: "Loaded outcome",
  };
  await writeFile(join(f.root, "tickets.json"), JSON.stringify([loaded]));
  const engine = createFactory(f.root, f.host, openStore);
  const storage = openPersistence(engine.directory, []);
  storage.commit(
    { enabled: false, owner: "T-owner", runs: {} },
    "factory",
    "fixture",
    "",
  );
  storage.close();
  await engine.tick("reload", "T-owner");
  const definition = join(f.root, ".factory.json");
  const raw = await Bun.file(definition).json();
  await writeFile(
    join(f.root, "future-tickets.json"),
    JSON.stringify([
      { ...loaded, brief: "Unloaded scope", outcome: "Unloaded outcome" },
      { id: "future-legacy", brief: "Unloaded legacy", after: [] },
      { ...loaded, id: "future-planned" },
    ]),
  );
  await writeFile(
    definition,
    JSON.stringify({ ...raw, tickets: "future-tickets.json" }),
  );
  expect(
    engine.tick(
      "admit",
      "T-owner",
      f.host.state,
      undefined,
      undefined,
      "future-planned",
    ),
  ).rejects.toThrow("Unknown planned ticket");
  await engine.tick(
    "admit",
    "T-owner",
    f.host.state,
    undefined,
    undefined,
    "A",
  );
  const retained = openPersistence(engine.directory, []);
  expect(retained.tickets).toEqual([{ ...loaded, intake: "admitted" }]);
  retained.close();
  expect(factoryRecords(engine.directory)?.tickets).toEqual([
    { id: "A", steps: [], intake: "admitted", outcome: "Loaded outcome" },
  ]);
  await engine.tick("reload", "T-owner");
  await engine.tick(
    "admit",
    "T-owner",
    f.host.state,
    undefined,
    undefined,
    "future-planned",
  );
  expect(
    factoryRecords(engine.directory)?.tickets.map((task) => task.id),
  ).toEqual(["A", "future-legacy", "future-planned"]);
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test("invalid worker runner settings reject dispatch before creating a thread", async () => {
  const f = await preparationFixture(() => "");
  const path = join(f.root, ".factory.json");
  const raw = await Bun.file(path).json();
  for (const workerRunner of [null, "", " \t", 42, {}, []]) {
    await writeFile(path, JSON.stringify({ ...raw, workerRunner }));
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
      "Expected nonempty text",
    );
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  }
  await writeFile(path, JSON.stringify(raw));
  expect((await f.factory().tick("start", "T-owner")).runs.A).toMatchObject({
    kind: "running",
    executor: "local",
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("connected watchdog gates start, restores registration on reload and denies nonowners before effects", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const engine = createFactory(f.root, f.host, openStore, () => at);
  let calls = 0;
  const unavailable = {
    async call() {
      calls++;
      throw new Error("Schedule bridge disconnected");
    },
  };
  expect(
    await engine
      .tick("start", "T-owner", f.host.state, undefined, unavailable)
      .catch(String),
  ).toMatch(/disconnected/);
  expect(await engine.tick("status")).toMatchObject({
    enabled: false,
    monitor: { schedule: "unknown" },
    runs: {},
  });
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  expect(calls).toBe(1);
  expect((await engine.tick("status")).owner).toBeUndefined();
  const foreign = watchdogFixture().tools;
  await foreign.call("amp.set_schedule", {
    title: "Unrelated",
    prompt: "Keep",
  });
  expect(
    await engine
      .tick("start", "T-refused", f.host.state, undefined, foreign)
      .catch(String),
  ).toMatch(/unrelated/);
  expect((await engine.tick("status")).owner).toBeUndefined();
  const { tools, notifications } = watchdogFixture();
  const started = await engine.tick(
    "start",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(started).toMatchObject({
    enabled: true,
    monitor: { schedule: "installed" },
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
  await tools.call("amp.clear_schedule", {});
  const reloaded = await engine.tick(
    "reload",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(reloaded.monitor?.schedule).toBe("installed");
  expect(await tools.call("amp.get_schedule", {})).toMatchObject({
    enabled: true,
  });
  const bytes = await readFile(join(engine.directory, "state.sqlite"));
  for (const caller of ["T-prepared", "T-stranger"] as const) {
    for (const action of ["start", "pause", "reload", "reconcile"] as const)
      expect(
        await engine
          .tick(action, caller, f.host.state, undefined, unavailable)
          .catch(String),
      ).toMatch(/Workers|Foreman/);
  }
  expect(
    await engine
      .tick("status", "T-owner", f.host.state, undefined, unavailable)
      .catch(String),
  ).toMatch(/Foreman/);
  expect(calls).toBe(1);
  expect(await readFile(join(engine.directory, "state.sqlite"))).toEqual(bytes);
  at += 1_800_000;
  const nudges: string[] = [];
  f.host.send = async (_id, message) => {
    nudges.push(message);
  };
  await engine.tick("reconcile");
  expect(nudges).toEqual([]);
  expect(notifications).toEqual([]);
  const diagnosed = await engine.tick(
    "reconcile",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(nudges).toEqual([expect.stringContaining("Diagnose current status")]);
  expect(notifications).toHaveLength(1);
  expect(diagnosed.runs.A).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    attempt: 1,
  });
  const storage = openPersistence(engine.directory, []);
  storage.state.runs.A = {
    kind: "done",
    thread: "T-prepared",
    revision: "accepted",
    insight: "Fixture",
  };
  storage.commit(storage.state, "A", "accepted", "Fixture");
  storage.close();
  await engine.tick("reconcile", "T-owner", f.host.state, undefined, tools);
  expect(await tools.call("amp.get_schedule", {})).toBeNull();
  expect((await engine.tick("status")).monitor?.schedule).toBe("cleared");
});

test("post-dispatch inspection failure retains enabled execution and its watchdog", async () => {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const fixture = watchdogFixture();
  const effects: string[] = [];
  let lost = false;
  let reads = 0;
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.get_schedule") {
        reads++;
        if (!lost && f.counts().sends === 1) {
          lost = true;
          throw new Error("Post-dispatch inspection unavailable");
        }
      } else effects.push(name);
      return fixture.tools.call(name, input);
    },
  };
  const started = await engine.tick(
    "start",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(lost).toBe(true);
  expect(started).toMatchObject({
    enabled: true,
    owner: "T-owner",
    monitor: {
      schedule: "unknown",
      problem: expect.stringContaining("Post-dispatch inspection unavailable"),
    },
  });
  expect(started.runs.A).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    attempt: 1,
  });
  expect((await engine.tick("status")).enabled).toBe(true);
  const storage = openPersistence(engine.directory, []);
  try {
    expect(storage.lastEvent("factory", "started")).toBe("T-owner");
    expect(
      storage.lastEvent("factory", "watchdog-installation-failed"),
    ).toBeUndefined();
    expect(storage.lastEvent("factory", "watchdog-unconfirmed")).toContain(
      "Post-dispatch inspection unavailable",
    );
  } finally {
    storage.close();
  }
  const inspected = reads;
  const recovered = await engine.tick(
    "reconcile",
    "T-owner",
    f.host.state,
    undefined,
    tools,
  );
  expect(reads).toBeGreaterThan(inspected);
  expect(recovered).toMatchObject({
    enabled: true,
    monitor: { schedule: "installed" },
  });
  expect(recovered.runs.A).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    attempt: 1,
  });
  expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
    enabled: true,
  });
  expect(effects).toEqual(["amp.set_schedule"]);
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("reload retains monitoring for unfinished persisted tickets removed from the authored queue", async () => {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const fixture = watchdogFixture();
  const effects: string[] = [];
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name !== "amp.get_schedule") effects.push(name);
      return fixture.tools.call(name, input);
    },
  };
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  await writeFile(join(f.root, "tickets.json"), "[]");
  for (const action of ["reload", "reconcile"] as const) {
    const state = await engine.tick(
      action,
      "T-owner",
      f.host.state,
      undefined,
      tools,
    );
    expect(state.monitor?.schedule).toBe("installed");
    expect(state.runs.A).toMatchObject({
      kind: "running",
      thread: "T-prepared",
    });
  }
  expect(effects).toEqual(["amp.set_schedule"]);
});

test("an observer takes wakes and nudges but may only reconcile and read the summary", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const engine = createFactory(f.root, f.host, openStore, () => at);
  const { tools, schedules, notifications } = watchdogFixture();
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  expect([...schedules.keys()]).toEqual(["T-owner"]);
  const created: unknown[] = [];
  f.host.create = async (...args) => {
    created.push(args);
    return "T-observer";
  };
  await engine.observer("register-observer", "T-owner", tools);
  await engine.observer("register-observer", "T-owner", tools);
  expect(created).toEqual([
    ["T-owner", "anthropic/claude-haiku-5-5", "high", "observer"],
  ]);
  expect((await engine.tick("status")).foreman?.observer).toEqual({
    thread: "T-observer",
    model: "anthropic/claude-haiku-5-5",
    effort: "high",
    at: 1000,
  });
  expect([...schedules.keys()]).toEqual(["T-observer"]);
  expect(schedules.get("T-observer")).toMatchObject({
    targetThreadID: "T-observer",
    runMode: "existing",
    enabled: true,
  });
  const prompt = String(schedules.get("T-observer")!.prompt);
  expect(prompt).toContain("status-summary");
  // Healthy progress such as building to reviewing must not wake the owner.
  expect(prompt).not.toContain("verdict, kind or stage");
  expect(prompt).toContain("building to reviewing, is routine progress");
  const saved = await engine.tick("status");
  const events = factoryEvents(engine.directory, 0, 500)!.length;
  for (const action of [
    "start",
    "pause",
    "resume",
    "retry-create",
    "retry-setup",
    "admit",
    "reload",
    "record-insight",
  ] as const)
    expect(await engine.tick(action, "T-observer").catch(String)).toMatch(
      /observer may only/,
    );
  for (const refused of [
    () => engine.recordMerge({}, "T-observer"),
    () => engine.recordLanding({}, "T-observer"),
    () => engine.note("Not mine", "T-observer"),
    () =>
      engine.handoff({ owner: "T-owner", decision: "x" }, "T-observer", tools),
    () => engine.observer("remove-observer", "T-observer", tools),
  ])
    expect(await refused().catch(String)).toMatch(/observer may only/);
  await engine.tick("reconcile", "T-observer");
  expect(await engine.tick("status")).toEqual(saved);
  expect(factoryEvents(engine.directory, 0, 500)).toHaveLength(events);
  const sent: [string, string][] = [];
  f.host.send = async (thread, message) => {
    sent.push([thread, message]);
  };
  at += 1_800_000;
  await engine.tick("reconcile", "T-observer");
  expect(sent).toEqual([
    ["T-observer", expect.stringContaining("Factory suspicion")],
  ]);
  expect(notifications).toEqual([]);
  await engine.observer("remove-observer", "T-owner", tools);
  expect([...schedules.keys()]).toEqual(["T-owner"]);
  expect((await engine.tick("status")).foreman?.observer).toBeUndefined();
  at += 1_800_000;
  await engine.tick("reconcile", "T-owner", f.host.state, undefined, tools);
  expect(sent.slice(1)).toEqual([
    ["T-owner", expect.stringContaining("Factory suspicion")],
  ]);
});

test("ordinary owner reconciles finish a failed or interrupted move to the observer", async () => {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const fixture = watchdogFixture();
  let failOwnerClear = true;
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (
        name === "amp.clear_schedule" &&
        input.thread === "T-owner" &&
        failOwnerClear
      )
        throw new Error("Lost owner clear");
      return fixture.tools.call(name, input);
    },
  };
  const reconcile = () =>
    engine.tick("reconcile", "T-owner", f.host.state, undefined, tools);
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  f.host.create = async () => "T-observer";
  await engine.observer("register-observer", "T-owner", tools);
  expect([...fixture.schedules.keys()].sort()).toEqual([
    "T-observer",
    "T-owner",
  ]);
  expect((await engine.tick("status")).monitor?.problem).toMatch(
    /Lost owner clear/,
  );
  expect((await reconcile()).monitor?.problem).toMatch(/Lost owner clear/);
  expect(fixture.schedules.has("T-owner")).toBe(true);
  failOwnerClear = false;
  const healed = await reconcile();
  expect([...fixture.schedules.keys()]).toEqual(["T-observer"]);
  expect(healed.monitor).toMatchObject({ schedule: "installed" });
  expect(healed.monitor?.problem).toBeUndefined();

  await engine.observer("remove-observer", "T-owner", tools);
  expect([...fixture.schedules.keys()]).toEqual(["T-owner"]);
  const storage = openPersistence(engine.directory, []);
  storage.state.foreman!.observer = {
    thread: "T-observer",
    model: "anthropic/claude-haiku-5-5",
    effort: "high",
    at: 1000,
  };
  storage.commit(storage.state, "factory", "observer-registered", "fixture");
  storage.close();
  await reconcile();
  expect([...fixture.schedules.keys()]).toEqual(["T-observer"]);
  await engine.tick("pause", "T-owner", f.host.state, undefined, tools);
  expect(fixture.schedules.size).toBe(0);
});

test("the status summary carries no private content and stays small for forty runs", () => {
  const canary = "PRIVATE-BRIEF-REPORT-PATH-THREAD-CONTENT";
  const running = (attempt: number) => ({
    kind: "running" as const,
    base: canary,
    worktree: `/${canary}`,
    thread: "T-worker" as const,
    attempt,
    delivery: "sent" as const,
    requirements: canary,
    feedback: canary,
    lane: "light" as const,
    stageAt: 5000,
    watchdog: {
      episode: canary,
      progressAt: 1,
      attempt,
      alerts: [
        {
          id: `alert-${String(attempt).padStart(30, "0")}`,
          kind: "unresolved" as const,
          episode: canary,
          attempt,
          intendedAt: 1,
        },
      ],
    },
    review: {
      ticket: canary,
      attempt,
      revision: "a".repeat(40),
      base: canary,
      stage: "post-graft" as const,
      worktree: canary,
      model: "anthropic/reviewer" as const,
      report: `/${canary}/report.json`,
      log: canary,
      command: canary,
      delivery: "sent" as const,
      thread: "T-review" as const,
      evidence: canary,
    },
  });
  const runs = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `${"X".repeat(70)}-${String(index).padStart(3, "0")}`,
      running(index + 1),
    ]),
  );
  const summary = statusSummary(
    {
      enabled: true,
      owner: "T-owner",
      runs,
      monitor: { fingerprint: "f", schedule: "installed", notifications: [] },
    },
    1000,
  );
  const json = JSON.stringify(summary);
  expect(json).not.toContain(canary);
  expect(json).not.toContain("T-worker");
  expect(json).not.toContain("T-review");
  expect(Buffer.byteLength(json)).toBeLessThan(16_384);
  expect(summary.due).toHaveLength(40);
  expect(summary.due[2]).toEqual({
    ticket: `${"X".repeat(70)}-002`,
    kind: "alert",
    id: `alert-${"3".padStart(30, "0")}:0`,
  });
  expect(summary.runs[2]).toEqual({
    ticket: `${"X".repeat(70)}-002`,
    kind: "running",
    lane: "light",
    attempt: 3,
    stage: "reviewing",
    progressAt: 5000,
    incident: null,
    review: "sent",
  });
});

test("a due continuation is listed from reset until the owner sends it", async () => {
  const f = await preparationFixture(() => "");
  let at = 1000;
  const engine = createFactory(f.root, f.host, openStore, () => at);
  const { tools } = watchdogFixture();
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  f.host.create = async () => "T-observer";
  await engine.observer("register-observer", "T-owner", tools);
  const limited = {
    kind: "provider-limit" as const,
    limit: { message: "limit", observedAt: 1000, resetAt: 3_601_000 },
  };
  f.host.state = async () => limited;
  await engine.tick("reconcile", "T-owner", f.host.state, undefined, tools);
  const incident = (await engine.tick("status")).runs.A!.incident!;
  expect(incident.reason).toBe("provider-limit");
  const summary = async () =>
    statusSummary(await engine.tick("status"), at).due;
  await engine.tick("reconcile", "T-observer");
  expect(await summary()).toEqual([]);
  at = 3_601_000;
  const events = factoryEvents(engine.directory, 0, 500)!.length;
  const continueDue = [
    {
      ticket: "A",
      kind: "continuation",
      id: `${incident.id}:continuation-due`,
    },
  ];
  for (let wake = 0; wake < 2; wake++) {
    await engine.tick("reconcile", "T-observer");
    expect(await summary()).toEqual(continueDue);
  }
  expect(factoryEvents(engine.directory, 0, 500)).toHaveLength(events);
  const sent: string[] = [];
  f.host.send = async (thread, message) => {
    if (thread === "T-prepared") sent.push(message);
  };
  await engine.tick("reconcile", "T-owner", f.host.state, undefined, tools);
  expect(sent).toEqual([expect.stringContaining("Continue the same")]);
  for (let wake = 0; wake < 2; wake++) {
    await engine.tick("reconcile", "T-observer");
    expect(await summary()).toEqual([]);
  }
  expect(sent).toHaveLength(1);
});

test("a held alert reservation is not due again; only a new intent is", async () => {
  const alert = (id: string) => ({
    id,
    kind: "unresolved" as const,
    episode: "episode",
    attempt: 1,
    intendedAt: 1,
  });
  const state: State = {
    enabled: true,
    owner: "T-owner",
    monitor: { fingerprint: "f", schedule: "installed", notifications: [] },
    runs: {
      A: {
        kind: "running",
        base: "base",
        worktree: "/worktree",
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
        watchdog: {
          episode: "episode",
          progressAt: 1,
          attempt: 1,
          alerts: [alert("first")],
        },
      },
    },
  };
  const due = () => statusSummary(state, 1000).due.map((item) => item.id);
  expect(due()).toEqual(["first:0"]);
  let notifies = 0;
  let lose = true;
  const tools = {
    async call() {
      notifies++;
      if (lose) throw new Error("Lost notification acknowledgement");
      return {};
    },
  };
  await deliverAlerts(
    state,
    tools,
    () => 1000,
    () => {},
  );
  expect(state.monitor!.notifications).toMatchObject([
    { id: "first", outcome: "unknown" },
  ]);
  for (let wake = 0; wake < 2; wake++) {
    expect(due()).toEqual([]);
    await deliverAlerts(
      state,
      tools,
      () => 1000,
      () => {},
    );
  }
  expect(notifies).toBe(1);
  const run = state.runs.A!;
  run.watchdog!.alerts.push(alert("second"));
  expect(due()).toEqual(["second:1000"]);
  lose = false;
  await deliverAlerts(
    state,
    tools,
    () => 1000,
    () => {},
  );
  expect(notifies).toBe(2);
  expect(due()).toEqual([]);
});

test("an alert held by the hourly budget is escalated again once capacity returns", async () => {
  const repair = {
    kind: "running" as const,
    base: "base",
    worktree: "/worktree",
    thread: "T-worker" as const,
    attempt: 4,
    delivery: "sent" as const,
  };
  const alert = (id: string) => ({
    id,
    kind: "parked" as const,
    episode: "episode",
    attempt: 4,
    intendedAt: 1,
  });
  const state: State = {
    enabled: true,
    owner: "T-owner",
    monitor: {
      fingerprint: "f",
      schedule: "installed",
      notifications: Array.from({ length: 9 }, (_, index) => ({
        id: `earlier-${index}`,
        at: 1000,
        outcome: "sent" as const,
      })),
    },
    runs: {
      A: {
        kind: "parked",
        reason: "Attempt cap",
        thread: "T-worker",
        repair,
        watchdog: {
          episode: "episode",
          progressAt: 1,
          attempt: 4,
          alerts: [alert("a"), alert("b")],
        },
      },
    },
  };
  const sent: unknown[] = [];
  const tools = {
    async call(_name: string, input: Record<string, unknown>) {
      sent.push(input.title);
      return {};
    },
  };
  const due = (at: number) =>
    statusSummary(state, at).due.map((item) => item.id);
  const deliver = (at: number) =>
    deliverAlerts(
      state,
      tools,
      () => at,
      () => {},
    );
  expect(due(2000)).toEqual(["a:1000", "b:1000"]);
  await deliver(2000);
  expect(sent).toHaveLength(1);
  for (const at of [2000, 1_800_000, 3_600_999]) {
    expect(due(at)).toEqual([]);
    await deliver(at);
  }
  expect(sent).toHaveLength(1);
  expect(due(3_601_000)).toEqual(["b:2000"]);
  await deliver(3_601_000);
  expect(sent).toHaveLength(2);
  expect(due(3_601_000)).toEqual([]);
});

test("a removed observer keeps no control right, even after a replacement registers", async () => {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const { tools } = watchdogFixture();
  await engine.tick("start", "T-owner", f.host.state, undefined, tools);
  let next: ThreadID = "T-observer";
  f.host.create = async () => next;
  await engine.observer("register-observer", "T-owner", tools);
  await engine.observer("remove-observer", "T-owner", tools);
  next = "T-replacement";
  await engine.observer("register-observer", "T-owner", tools);
  f.host.state = async () => "idle";
  const saved = await engine.tick("status");
  const events = factoryEvents(engine.directory, 0, 500)!.length;
  for (const action of ["pause", "reload", "reconcile"] as const)
    expect(
      await engine
        .tick(action, "T-observer", f.host.state, undefined, tools)
        .catch(String),
    ).toMatch(/removed factory observer/);
  expect(
    await engine
      .handoff({ owner: "T-owner", decision: "Take over" }, "T-observer", tools)
      .catch(String),
  ).toMatch(/removed factory observer/);
  for (const action of ["backup", "status-summary"])
    expect(() => assertControlCaller(saved, "T-observer", action)).toThrow(
      /removed factory observer/,
    );
  expect(await engine.tick("status")).toEqual(saved);
  expect(saved).toMatchObject({ enabled: true, owner: "T-owner" });
  expect(factoryEvents(engine.directory, 0, 500)).toHaveLength(events);
  await engine.tick("reconcile", "T-replacement");
});

test("watchdog persistence failures still abort before remote effects or dispatch", async () => {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  await mkdir(engine.directory, { recursive: true });
  openPersistence(engine.directory, []).close();
  const db = new Database(join(engine.directory, "state.sqlite"));
  db.run(`CREATE TRIGGER fail_monitor BEFORE INSERT ON events
    WHEN NEW.action = 'watchdog-schedule'
    BEGIN SELECT RAISE(ABORT, 'monitor-save-failed'); END`);
  db.close();
  const fixture = watchdogFixture();
  expect(
    await engine
      .tick("start", "T-owner", f.host.state, undefined, fixture.tools)
      .catch(String),
  ).toMatch(/monitor-save-failed/);
  expect(await fixture.tools.call("amp.get_schedule", {})).toBeNull();
  expect(await engine.tick("status")).toMatchObject({
    enabled: false,
    runs: {},
  });
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test.each(["unavailable", "unrecognized"])(
  "owner recovery and stop notices survive %s inspection",
  async (fault) => {
    const f = await preparationFixture(() => "");
    const engine = createFactory(f.root, f.host, openStore, () => 1000);
    const fixture = watchdogFixture();
    await engine.tick(
      "start",
      "T-owner",
      f.host.state,
      undefined,
      fixture.tools,
    );
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({ kind: "blocked", attempt: 1, reason: "Private" }),
    );
    f.host.state = async () => "idle";
    f.host.send = async () => {
      throw new Error("Notice unavailable");
    };
    const stopped = await engine.tick("reconcile");
    const incident = stopped.runs.A!.incident!;
    const notices: string[] = [];
    f.host.send = async (_id, message) => {
      notices.push(message);
    };
    const tools = {
      async call(name: string) {
        expect(name).toBe("amp.get_schedule");
        if (fault === "unavailable") throw new Error("Inspection unavailable");
        return "{unexpected bridge response";
      },
    };
    const reconciled = await engine.tick(
      "reconcile",
      "T-owner",
      f.host.state,
      undefined,
      tools,
    );
    expect(reconciled.runs.A!.incident?.delivery).toBe("sent");
    expect(notices).toEqual([expect.stringContaining(incident.id)]);
    await engine.tick("pause", "T-owner", f.host.state, undefined, tools);
    expect(
      await engine.tick("reload", "T-owner", f.host.state, undefined, tools),
    ).toMatchObject({
      enabled: false,
      monitor: { schedule: "unknown", problem: expect.any(String) },
    });
    const resumed = await engine.tick(
      "resume",
      "T-owner",
      f.host.state,
      {
        ticket: "A",
        incident: incident.id,
        decision: "Root cause resolved",
      },
      tools,
    );
    expect(resumed).toMatchObject({
      enabled: false,
      monitor: {
        schedule: "unknown",
        problem: expect.stringContaining("inspection failed"),
      },
    });
    expect(resumed.runs.A).toMatchObject({
      kind: "running",
      thread: "T-prepared",
      attempt: 2,
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    expect(fixture.notifications).toEqual([]);
  },
);

test("paused foreign schedule preserves notices and exact-incident resume", async () => {
  const f = await preparationFixture(() => "");
  const engine = createFactory(f.root, f.host, openStore, () => 1000);
  const { tools } = watchdogFixture();
  const sync = (action: "start" | "pause" | "reconcile") =>
    engine.tick(action, "T-owner", f.host.state, undefined, tools);
  await sync("start");
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({
      kind: "blocked",
      attempt: 1,
      reason: "Private failure",
    }),
  );
  f.host.state = async () => "idle";
  f.host.send = async () => {
    throw new Error("Notice unavailable");
  };
  const stopped = await sync("reconcile");
  const incident = stopped.runs.A!.incident!;
  const notices: string[] = [];
  f.host.send = async (_id, message) => {
    notices.push(message);
  };
  const foreign = { title: "Unrelated reminder", prompt: "Preserve me" };
  await tools.call("amp.clear_schedule", {});
  await tools.call("amp.set_schedule", foreign);
  expect((await sync("pause")).enabled).toBe(false);
  expect(notices).toEqual([expect.stringContaining(incident.id)]);
  expect((await sync("reconcile")).monitor?.schedule).toBe("cleared");
  const resumed = await engine.tick(
    "resume",
    "T-owner",
    f.host.state,
    {
      ticket: "A",
      incident: incident.id,
      decision: "Root cause resolved",
    },
    tools,
  );
  expect(resumed.enabled).toBe(false);
  expect(resumed.runs.A).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    attempt: 2,
  });
  expect(await tools.call("amp.get_schedule", {})).toMatchObject(foreign);
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test.each(["fingerprint", "inspection"])(
  "pause persists despite watchdog %s failure",
  async (fault) => {
    const f = await preparationFixture(() => "");
    const engine = createFactory(f.root, f.host, openStore, () => 1000);
    const fixture = watchdogFixture();
    await engine.tick(
      "start",
      "T-owner",
      f.host.state,
      undefined,
      fixture.tools,
    );
    if (fault === "fingerprint") {
      const storage = openPersistence(engine.directory, []);
      storage.state.monitor!.fingerprint = "copied-from-another-root";
      storage.commit(storage.state, "factory", "fixture-copy", "");
      storage.close();
    }
    const tools =
      fault === "fingerprint"
        ? fixture.tools
        : {
            async call() {
              throw new Error("Inspection unavailable");
            },
          };
    const paused = await engine.tick(
      "pause",
      "T-owner",
      f.host.state,
      undefined,
      tools,
    );
    expect(paused.monitor?.problem).toMatch(/fingerprint|Inspection/);
    const saved = await engine.tick("status");
    expect(saved.enabled).toBe(false);
    expect(saved.monitor?.schedule).toBe(
      fault === "fingerprint" ? "conflict" : "unknown",
    );
    expect((await engine.tick("reconcile")).enabled).toBe(false);
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
  },
);

test.each(["start", "pause"] as const)(
  "uncertain first registration stays thread-bound until %s",
  async (action) => {
    const f = await preparationFixture(() => "");
    const engine = createFactory(f.root, f.host, openStore, () => 1000);
    const fixture = watchdogFixture();
    let disconnected = false;
    const tools = {
      async call(name: string, input: Record<string, unknown>) {
        if (disconnected) throw new Error("Inspection unavailable");
        if (name === "amp.set_schedule")
          expect(factoryStatus(engine.directory).owner).toBeUndefined();
        const result = await fixture.tools.call(name, input);
        if (name === "amp.set_schedule") disconnected = true;
        return result;
      },
    };
    expect(
      await engine
        .tick("start", "T-first", f.host.state, undefined, tools)
        .catch(String),
    ).toMatch(/Inspection/);
    expect((await engine.tick("status")).owner).toBeUndefined();
    const other = watchdogFixture();
    expect(
      await engine
        .tick("start", "T-other", f.host.state, undefined, other.tools)
        .catch(String),
    ).toMatch(/T-first/);
    expect(await other.tools.call("amp.get_schedule", {})).toBeNull();
    disconnected = false;
    const recovered = await engine.tick(
      action,
      "T-first",
      f.host.state,
      undefined,
      tools,
    );
    expect(recovered.monitor?.schedule).toBe(
      action === "start" ? "installed" : "cleared",
    );
    expect(recovered.owner).toBe(action === "start" ? "T-first" : undefined);
    expect(f.counts().creates).toBe(action === "start" ? 1 : 0);
  },
);

test("a later unchanged tools sample opens one suspected stop and real edits restart the window", async () => {
  const f = await preparationFixture(() => "");
  const fixture = watchdogFixture();
  let at = 1000;
  let updatedAt = at;
  let activity: "running_tools" | "streaming" | "idle" = "running_tools";
  const observe: NativeHost["state"] = async (_thread, sample) =>
    sample ? { kind: "sample", state: activity, updatedAt } : "running";
  let engine = createFactory(f.root, f.host, openStore, () => at);
  const sync = (action: "start" | "reconcile" = "reconcile") =>
    engine.tick(action, "T-owner", observe, undefined, fixture.tools);
  const currentIncident = async () => (await sync()).runs.A?.incident;
  const initial = (await sync("start")).runs.A;
  expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
    trigger: {
      schedule: "DTSTART:19700101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=1",
    },
  });
  const tracked = join(f.worktree, "prd.md");
  const scratch = join(f.worktree, "new-file");
  await writeFile(tracked, "first draft");
  await writeFile(scratch, "first draft");
  await sync();
  engine = createFactory(f.root, f.host, openStore, () => at);
  at = 180_000;
  expect(await currentIncident()).toBeUndefined();
  at = 182_000;
  const stopped = (await sync()).runs.A!;
  expect(stopped.incident).toMatchObject({
    reason: "disconnected",
    recovery: "reconnect",
    cause: { role: "worker", thread: "T-prepared" },
  });
  expect(runStage(stopped).stage).toBe("disconnected");
  const events = factoryEvents(engine.directory);
  expect((await sync()).runs.A).toEqual(stopped);
  expect(factoryEvents(engine.directory)).toEqual(events);
  expect((await engine.tick("reconcile", "T-owner")).runs.A).toEqual(stopped);

  for (const file of [tracked, scratch]) {
    at += 1;
    await writeFile(file, "second draft");
    expect(await currentIncident()).toBeUndefined();
    at += 179_999;
    expect(await currentIncident()).toBeUndefined();
    at += 1;
    expect(await currentIncident()).toMatchObject({ reason: "disconnected" });
  }
  execFileSync("git", [
    "-C",
    f.worktree,
    "commit",
    "--allow-empty",
    "-qm",
    "Progress",
  ]);
  expect(await currentIncident()).toBeUndefined();
  updatedAt = ++at;
  expect(await currentIncident()).toBeUndefined();
  at += 181_000;
  expect(await currentIncident()).toMatchObject({ reason: "disconnected" });
  activity = "streaming";
  expect(await currentIncident()).toBeUndefined();
  activity = "running_tools";
  expect(await currentIncident()).toBeUndefined();
  at += 181_000;
  expect(await currentIncident()).toMatchObject({ reason: "disconnected" });
  activity = "idle";
  expect((await sync()).runs.A).toMatchObject({
    kind: "running",
    worktree: f.worktree,
    thread: "T-prepared",
    attempt: 1,
  });
  expect(factoryStatus(engine.directory).runs.A?.incident).toBeUndefined();
  expect(initial).toMatchObject({ thread: "T-prepared", attempt: 1 });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("F045 repair: connected progress survives an unreadable worktree and restart", async () => {
  const f = await preparationFixture(() => "");
  let at = 181_000;
  let updatedAt = 0;
  const observe: NativeHost["state"] = async () => ({
    kind: "sample",
    state: "running_tools",
    updatedAt,
  });
  const { tools } = watchdogFixture();
  let engine = createFactory(f.root, f.host, openStore, () => at);
  const sync = async (action: "start" | "reconcile" = "reconcile") =>
    (await engine.tick(action, "T-owner", observe, undefined, tools)).runs.A
      ?.incident;
  await sync("start");
  await sync();
  expect(await sync()).toMatchObject({ reason: "disconnected" });
  const moved = `${f.worktree}-unavailable`;
  await rename(f.worktree, moved);
  try {
    updatedAt = 1_000;
    expect(await sync()).toBeUndefined();
  } finally {
    await rename(moved, f.worktree);
  }
  engine = createFactory(f.root, f.host, openStore, () => at);
  expect(await sync()).toBeUndefined();
  at += 60_000;
  expect(await sync()).toBeUndefined();
  at += 120_000;
  expect(await sync()).toMatchObject({ reason: "disconnected" });
});

test("F045 repair: a tracked binary edit over 3 MB remains observable", async () => {
  const f = await preparationFixture(() => "");
  let at = 1_000;
  const { tools } = watchdogFixture();
  const observe: NativeHost["state"] = async () => ({
    kind: "sample",
    state: "running_tools",
    updatedAt: 1_000,
  });
  const engine = createFactory(f.root, f.host, openStore, () => at);
  const sync = async (action: "start" | "reconcile" = "reconcile") =>
    (await engine.tick(action, "T-owner", observe, undefined, tools)).runs.A
      ?.incident;
  await sync("start");
  const binary = join(f.worktree, "binary.dat");
  await writeFile(binary, Buffer.alloc(4_000_000));
  execFileSync("git", ["-C", f.worktree, "add", "binary.dat"]);
  execFileSync("git", ["-C", f.worktree, "commit", "-qm", "Track binary"]);
  await writeFile(binary, randomBytes(4_000_000));
  expect(await sync()).toBeUndefined();
  at += 180_000;
  expect(await sync()).toMatchObject({ reason: "disconnected" });
  await writeFile(binary, randomBytes(4_000_000));
  expect(await sync()).toBeUndefined();
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
      import { watchdogFixture } from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
      const host = {
        async create() { throw new Error("No replacement"); },
        async send() { process.exit(23); },
        async state() { return "unknown"; }, watch() {},
      };
      await createFactory(${JSON.stringify(f.root)}, host, openStore, () => 1801000).tick("reconcile", "T-owner", host.state, undefined, watchdogFixture().tools);
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
  expect(retried.watchdog!.alerts).toMatchObject(reserved.watchdog!.alerts);
  expect(retried.watchdog!.alerts[0]?.acknowledgedAt).toBe(1_801_000);
  expect(retried).toMatchObject({
    kind: "running",
    attempt: 1,
    thread: "T-prepared",
  });
  expect(f.counts().creates).toBe(1);
});

test.each([
  ["insight", { insight: undefined }],
  ["insight", { insight: "" }],
  ["attempt", { attempt: "1" }],
  ["revision", { revision: "a".repeat(39) }],
  ["kind", { kind: "failed" }],
  ["JSON", null],
  ["reason", { kind: "blocked", reason: " " }],
  ["summary", { summary: 3 }],
] as const)(
  "malformed worker report returns %s to the same worker (%j)",
  async (field, patch) => {
    const f = await preparationFixture(() => "");
    const engine = f.factory();
    const messages: string[] = [];
    f.host.send = async (thread, message) => {
      expect(thread).toBe("T-prepared");
      messages.push(message);
    };
    await engine.tick("start", "T-owner");
    const base = f.git("rev-parse", "HEAD");
    const path = join(engine.directory, "A.report.json");
    await writeFile(
      path,
      patch
        ? JSON.stringify({
            attempt: 1,
            kind: "candidate",
            revision: base,
            insight: "Verified",
            ...patch,
          })
        : "{",
    );
    f.host.state = async () => "idle";
    const repair = {
      kind: "running",
      attempt: 2,
      rejectedBy: "report",
      thread: "T-prepared",
    };
    expect((await engine.tick("reconcile")).runs.A).toMatchObject(repair);
    expect(messages[1]).toContain(`Invalid worker report: ${field}`);
    const events = factoryEvents(engine.directory, 0, 500)!;
    expect(
      JSON.parse(events.find((event) => event.action === "rejected")!.detail),
    ).toMatchObject({
      reason: "report-invalid",
      attempt: 1,
    });
    expect((await f.factory().tick("reconcile")).runs.A).toMatchObject(repair);
    await writeFile(
      path,
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision: base,
        insight: "Old attempt",
      }),
    );
    expect((await engine.tick("reconcile")).runs.A).toMatchObject(repair);
    expect(factoryEvents(engine.directory, 0, 500)).toEqual(events);
    expect(messages).toHaveLength(2);
    expect(f.counts().creates).toBe(1);
    expect(f.git("rev-parse", "HEAD")).toBe(base);
  },
);

test("the blocked example in the worker brief is a valid report", () => {
  expect(parseWorkerReport(workerReportExamples(3).blocked, 3)).toEqual({
    kind: "blocked",
    attempt: 3,
    reason: "<needed decision>",
  });
});

test.each([
  "F041-merge-proof-paths",
  "F042-restricted-foreman-tools",
  "F043-installed-policy-identity",
  "enforce-human-capped-resume",
])("accepts worker report fixture %s", async (name) => {
  const source = await readFile(
    join(import.meta.dir, "fixtures/worker-reports", `${name}.report.json`),
    "utf8",
  );
  const { attempt, revision: original, insight } = JSON.parse(source);
  expect(parseWorkerReport(source, attempt)).toMatchObject({
    kind: "candidate",
    attempt,
    revision: original,
    insight,
  });
  const f = await preparationFixture(() => "");
  const engine = f.factory();
  await engine.tick("start", "T-owner");
  f.host.state = async () => "idle";
  const path = join(engine.directory, "A.report.json");
  if (attempt === 2) {
    await writeFile(
      path,
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision: original,
        insight: "Prior attempt",
      }),
    );
    expect((await engine.tick("reconcile")).runs.A).toMatchObject({
      attempt: 2,
      rejectedBy: "gate",
    });
  }
  await mkdir(join(f.worktree, "src"));
  await writeFile(join(f.worktree, "src/value"), name);
  f.git("-C", f.worktree, "add", "src");
  f.git("-C", f.worktree, "commit", "-qm", "fixture candidate");
  const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
  // The private fixture commits are unavailable here; bind each report to a real test commit.
  await writeFile(path, source.replace(original, revision));
  const accepted = await engine.tick("reconcile");
  expect(accepted.runs.A).toMatchObject({
    kind: "done",
    attempt,
    revision,
    insight,
  });
  expect(insight).not.toBe("");
  expect(f.git("rev-parse", "HEAD")).toBe(revision);
});

test("acceptance caps insight and discards unknown report keys from evidence and feed", async () => {
  const f = await preparationFixture(() => "");
  const engine = f.factory();
  await engine.tick("start", "T-owner");
  await mkdir(join(f.worktree, "src"));
  await writeFile(join(f.worktree, "src/value"), "verified");
  f.git("-C", f.worktree, "add", "src");
  f.git("-C", f.worktree, "commit", "-qm", "fixture candidate");
  const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
  const insight = "x".repeat(1000);
  const report = {
    attempt: 1,
    kind: "candidate",
    revision,
    insight,
    summary: "Verified result",
  };
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({
      ...report,
      insight: `${insight}suffix`,
      unknown: "PRIVATE-CANARY",
    }),
  );
  f.host.state = async () => "idle";
  const accepted = await engine.tick("reconcile");
  expect(accepted.runs.A).toMatchObject({
    kind: "done",
    insight,
    summary: report.summary,
  });
  expect(JSON.stringify(accepted)).not.toContain("PRIVATE-CANARY");
  const proof = factoryEvidence(engine.directory, "A")!.find(
    (row) => row.kind === "report",
  )!;
  expect(
    JSON.parse(evidenceContent(engine.directory, "A", proof.sha256)),
  ).toEqual(report);
  const server = startDashboard({ root: f.root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${server.port}/api/status`);
    const feed = await response.text();
    expect(feed).toContain(report.summary);
    expect(feed).not.toContain("PRIVATE-CANARY");
  } finally {
    await server.stop(true);
  }
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

test("four rejections park the worker, release only independent work and require exact owner resume", async () => {
  const f = await preparationFixture(() => "");
  const configPath = join(f.root, ".factory.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.verify = "test -f src/independent";
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(f.root, "tickets.json"),
    JSON.stringify([
      { id: "A", brief: "PRIVATE-BRIEF", after: [] },
      { id: "B", brief: "Dependent", after: ["A"] },
      { id: "C", brief: "Independent", after: [] },
    ]),
  );
  f.git("add", ".factory.json", "tickets.json");
  f.git("commit", "-qm", "fixture queue");
  const create = f.host.create.bind(f.host);
  f.host.create = async (...args) => {
    const thread = await create(...args);
    return f.counts().creates === 1
      ? thread
      : f.counts().creates === 2
        ? "T-independent"
        : "T-dependent";
  };
  const messages: string[] = [];
  const notices: string[] = [];
  const send = f.host.send.bind(f.host);
  f.host.send = async (thread, message) => {
    if (thread === "T-prepared") messages.push(message);
    if (thread === "T-owner") notices.push(message);
    await send(thread, message);
  };
  const workerGit = (worktree: string, ...args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
    }).trim();
  async function candidateCommit(
    worktree: string,
    file: string,
    value: string,
  ) {
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src", file), value);
    workerGit(worktree, "add", "src/");
    workerGit(worktree, "commit", "-qm", "fixture candidate");
    return workerGit(worktree, "rev-parse", "HEAD");
  }
  let at = 1000;
  const engine = f.factory(() => at);
  await engine.tick("start", "T-owner");
  f.host.state = async () => "idle";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const revision = await candidateCommit(f.worktree, "value", `${attempt}`);
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        kind: "candidate",
        attempt,
        revision,
        insight: "Verified candidate",
      }),
    );
    if (attempt === 4) {
      const db = new Database(join(engine.directory, "state.sqlite"));
      try {
        db.run(
          "CREATE TRIGGER fail_park BEFORE INSERT ON events WHEN NEW.action = 'parked' BEGIN SELECT RAISE(ABORT, 'fixture park failure'); END",
        );
        expect(await engine.tick("reconcile").catch(String)).toMatch(
          /fixture park failure/,
        );
        expect(factoryStatus(engine.directory).runs.A).toMatchObject({
          kind: "running",
          attempt: 4,
          watchdog: { alerts: [] },
        });
        expect(f.notifications).toEqual([]);
        db.run("DROP TRIGGER fail_park");
      } finally {
        db.close();
      }
    }
    const state = await engine.tick("reconcile");
    expect(state.runs.A).toMatchObject({
      kind: attempt === 2 ? "blocked" : attempt === 4 ? "parked" : "running",
    });
    if (attempt < 4) expect(state.runs.C).toBeUndefined();
    if (attempt === 2) {
      expect(runStage(state.runs.A)).toMatchObject({
        stage: "escalated",
        actor: "foreman",
        step: "gate",
        status: "blocked",
      });
      expect(notices.at(-1)).toContain("Stage: escalated, waiting on foreman.");
      const originalBase = f.git("rev-parse", "HEAD");
      f.git("commit", "--allow-empty", "-qm", "advance blocked repair base");
      expect(
        await engine
          .tick("resume", "T-owner", f.host.state, {
            ticket: "A",
            incident: state.runs.A!.incident!.id,
            decision: "Do not repin a blocked repair",
          })
          .catch(String),
      ).toMatch(/Repair base/);
      f.git("reset", "--hard", originalBase);
      await engine.tick("resume", "T-owner", f.host.state, {
        ticket: "A",
        incident: state.runs.A!.incident!.id,
        decision: "Diagnosed the first escalation",
      });
    }
  }
  const state = factoryStatus(engine.directory);
  expect(runStage(state.runs.A)).toMatchObject({
    stage: "parked",
    actor: "operator",
    since: 1000,
  });
  expect(notices.at(-1)).toContain("Stage: parked, waiting on operator.");
  expect(state.runs.A).toMatchObject({
    kind: "parked",
    repair: { thread: "T-prepared", worktree: f.worktree, attempt: 4 },
    incident: {
      reason: "verification-rejected",
      recovery: "resume",
      attempt: 4,
    },
  });
  expect(state.runs.B).toBeUndefined();
  expect(state.runs.C).toMatchObject({
    kind: "running",
    thread: "T-independent",
  });
  expect(messages).toHaveLength(4);
  expect(f.counts().creates).toBe(2);
  const notice = state.runs.A!.incident!;
  expect(state.runs.A!.watchdog!.alerts).toEqual([
    {
      id: expect.any(String),
      kind: "parked",
      episode: notice.id,
      attempt: 4,
      intendedAt: 1000,
      acknowledgedAt: 1000,
    },
  ]);
  expect(f.notifications).toEqual([
    {
      title: "Factory needs diagnosis",
      body: `Ticket A, attempt 4. Repair attempt cap reached; ticket parked. Incident ${notice.id}. Read factory status and private evidence; this alert grants no permission.`,
    },
  ]);
  const server = startDashboard({ root: f.root, port: 0 });
  try {
    const response = await fetch(`http://localhost:${server.port}/api/status`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks).toMatchObject([
      {
        id: "A",
        thread: "T-prepared",
        stage: "parked",
        actor: "operator",
        stageSince: new Date(1000).toISOString(),
        step: 4,
        rejectedBy: "gate",
        attempt: 4,
      },
      { id: "B", stage: "queued", step: null },
      {
        id: "C",
        thread: "T-independent",
        stage: "building",
        actor: "model",
        step: 2,
        rejectedBy: null,
      },
    ]);
    expect(body.stages.map((stage: { id: string }) => stage.id)).toContain(
      "rate-limited",
    );
    expect(JSON.stringify(body)).not.toContain("PRIVATE-BRIEF");
    expect(JSON.stringify(body)).not.toContain(engine.directory);
  } finally {
    await server.stop(true);
  }
  const request = {
    ticket: "A",
    incident: notice.id,
    decision: "Operator approved another try",
    humanConfirmation: {
      userID: "user-human-contributor",
      owner: notice.owner,
      ticket: "A",
      incident: notice.id,
      attempt: 4,
      base: notice.base,
      integrationBase: f.git("rev-parse", "HEAD"),
    },
  };
  const reopened = f.factory(() => at);
  const events = factoryEvents(engine.directory);
  await reopened.tick("reconcile");
  await reopened.tick("reconcile");
  expect(factoryEvents(engine.directory)).toEqual(events);
  expect(f.notifications).toHaveLength(1);
  expect(
    reopened.tick("resume", "T-owner", f.host.state, request),
  ).rejects.toThrow(/active/);
  const independent = join(f.root, ".git/factory/worktrees/C");
  const advancedBase = await candidateCommit(independent, "independent", "C");
  await writeFile(
    join(engine.directory, "C.report.json"),
    JSON.stringify({
      kind: "candidate",
      attempt: 1,
      revision: advancedBase,
      insight: "Verified candidate",
    }),
  );
  await reopened.tick("reconcile");
  expect(factoryStatus(engine.directory).runs.C).toMatchObject({
    kind: "done",
    revision: advancedBase,
    attempt: 1,
  });
  expect(f.git("rev-parse", "HEAD")).toBe(advancedBase);
  expect(advancedBase).not.toBe(notice.base);
  request.humanConfirmation.integrationBase = advancedBase;
  at += 86_400_000;
  await reopened.tick("reconcile");
  expect(factoryStatus(engine.directory).runs.A).toEqual(state.runs.A);
  expect(
    reopened.tick("resume", "T-stranger", f.host.state, request),
  ).rejects.toThrow();
  expect(
    reopened.tick("resume", "T-owner", f.host.state, {
      ...request,
      incident: "stale",
    }),
  ).rejects.toThrow(/exact/);
  expect(
    reopened.tick("resume", "T-owner", async () => "running", request),
  ).rejects.toThrow(/idle/);
  expect(
    reopened.tick("resume", "T-owner", f.host.state, {
      ...request,
      decision: " ",
    }),
  ).rejects.toThrow(/nonempty/);
  const beforeResume = factoryEvents(engine.directory);
  for (const worktree of [f.root, f.worktree]) {
    const dirty = join(worktree, "dirty");
    await writeFile(dirty, "uncommitted");
    expect(
      await reopened
        .tick("resume", "T-owner", f.host.state, request)
        .catch(String),
    ).toMatch(/Repair base or registered worker worktree changed/);
    await rm(dirty);
  }
  const unrelated = f.git(
    "commit-tree",
    `${advancedBase}^{tree}`,
    "-m",
    "same tree, unrelated history",
  );
  f.git("reset", "--hard", unrelated);
  request.humanConfirmation.integrationBase = unrelated;
  expect(
    await reopened
      .tick("resume", "T-owner", f.host.state, request)
      .catch(String),
  ).toMatch(/merge-base/);
  f.git("reset", "--hard", advancedBase);
  request.humanConfirmation.integrationBase = advancedBase;
  expect(factoryStatus(engine.directory).runs.A).toEqual(state.runs.A);
  expect(factoryEvents(engine.directory)).toEqual(beforeResume);
  expect(
    reopened.tick("resume", "T-owner", f.host.state, {
      ...request,
      humanConfirmation: undefined,
    }),
  ).rejects.toThrow(/human confirmation/);
  const humanConfirmation = request.humanConfirmation;
  const approvedRequest = { ...request, humanConfirmation };
  for (const stale of [
    { owner: "T-former" as const },
    { ticket: "B" },
    { incident: "stale" },
    { attempt: 3 },
    { base: advancedBase },
    { integrationBase: notice.base },
    { userID: "" },
  ]) {
    expect(
      reopened.tick("resume", "T-owner", f.host.state, {
        ...request,
        humanConfirmation: { ...humanConfirmation, ...stale },
      }),
    ).rejects.toThrow(/human confirmation/);
  }
  const cancelled = new AbortController();
  expect(
    reopened.tick(
      "resume",
      "T-owner",
      async () => {
        cancelled.abort();
        return "idle";
      },
      {
        ...approvedRequest,
        signal: cancelled.signal,
      },
    ),
  ).rejects.toThrow();
  const db = new Database(join(engine.directory, "state.sqlite"));
  try {
    db.run(
      "CREATE TRIGGER fail_resume BEFORE INSERT ON events WHEN NEW.action = 'repair-resumed' BEGIN SELECT RAISE(ABORT, 'fixture resume failure'); END",
    );
    expect(
      reopened.tick("resume", "T-owner", f.host.state, approvedRequest),
    ).rejects.toThrow(/fixture resume failure/);
  } finally {
    db.run("DROP TRIGGER fail_resume");
    db.close();
  }
  expect(factoryStatus(engine.directory).runs.A).toEqual(state.runs.A);
  expect(factoryEvents(engine.directory)).toEqual(beforeResume);
  expect(messages).toHaveLength(4);
  const resumed = await reopened.tick(
    "resume",
    "T-owner",
    f.host.state,
    approvedRequest,
  );
  expect(resumed.runs.A).toMatchObject({
    kind: "running",
    thread: "T-prepared",
    base: advancedBase,
    attempt: 5,
    delivery: "sent",
  });
  expect(resumed.runs.B).toBeUndefined();
  expect(messages).toHaveLength(5);
  expect(f.counts().creates).toBe(2);
  expect(
    f
      .factory(() => at)
      .tick("resume", "T-owner", f.host.state, approvedRequest),
  ).rejects.toThrow();
  const resumeEvents = factoryEvents(engine.directory)!.filter(
    (event) => event.action === "repair-resumed",
  );
  expect(JSON.parse(resumeEvents.at(-1)!.detail)).toMatchObject({
    humanConfirmation,
    attempt: 5,
    thread: "T-prepared",
  });
  expect(messages).toHaveLength(5);
  expect(messages[4]).toContain(`Rebase onto ${advancedBase}`);
  workerGit(f.worktree, "rebase", advancedBase);
  expect(await readFile(join(f.worktree, "src/value"), "utf8")).toBe("4");
  const revision = await candidateCommit(f.worktree, "value", "5");
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({
      kind: "candidate",
      attempt: 5,
      revision,
      insight: "Rebased value 5 preserves independent work",
    }),
  );
  const accepted = await reopened.tick("reconcile");
  expect(accepted.runs.A).toMatchObject({
    kind: "done",
    thread: "T-prepared",
    revision,
    acceptedBase: advancedBase,
    attempt: 5,
  });
  expect(f.git("rev-parse", "HEAD")).toBe(revision);
  expect(await readFile(join(f.root, "src/value"), "utf8")).toBe("5");
  expect(await readFile(join(f.root, "src/independent"), "utf8")).toBe("C");
  expect(accepted.runs.B).toMatchObject({
    kind: "running",
    thread: "T-dependent",
    base: revision,
  });
  expect(f.counts().creates).toBe(3);
  expect(notices[0]).toContain("a diagnosis decision");
  expect(notices[1]).toContain("Attempt cap reached");
  expect(notices[1]).toContain("authenticated human confirmation");
}, 30_000);

test.each(["pass", "fail", "stale", "restart", "default"] as const)(
  "scheduled proof handles %s on the exact landed revision",
  async (outcome) => {
    const f = await preparationFixture(() => "");
    const marks = join(f.root, ".git");
    const configPath = join(f.root, ".factory.json");
    const config = await Bun.file(configPath).json();
    if (outcome !== "default") config.permissions.scheduleGates = true;
    config.scheduledGate = { landing: "true", schedule: "*/5 * * * *" };
    config.verify = `git rev-parse HEAD >> '${marks}/full-runs'; test "$(cat src/value)" = repaired || { for i in {1..500}; do test -f '${marks}/release' && break; sleep 0.01; done; test "$(cat '${marks}/release')" = pass; }`;
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      join(f.root, "tickets.json"),
      JSON.stringify([
        { id: "A", brief: "Work", after: [] },
        { id: "B", brief: "Dependent", after: ["A"] },
      ]),
    );
    if (outcome === "pass") await migrateDefinition(f.root);
    f.git("add", "-A");
    f.git("commit", "-qm", "configure scheduled checks");
    const base = f.git("rev-parse", "HEAD");
    let at = 60_000;
    const engine = f.factory(() => at);
    await engine.tick("start");
    f.host.state = async () => "idle";
    await mkdir(join(f.worktree, "src"));
    const submit = async (attempt: number, value: string) => {
      await writeFile(join(f.worktree, "src/value"), value);
      execFileSync("git", ["-C", f.worktree, "add", "src"]);
      execFileSync("git", ["-C", f.worktree, "commit", "-qm", value]);
      const revision = execFileSync(
        "git",
        ["-C", f.worktree, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      await writeFile(
        join(engine.directory, "A.report.json"),
        JSON.stringify({
          kind: "candidate",
          attempt,
          revision,
          insight: "Fixture result",
        }),
      );
      return revision;
    };
    const revision = await submit(1, "candidate");
    if (outcome === "default") {
      const checking = engine.tick("reconcile");
      await waitForFile(join(marks, "full-runs"));
      expect(f.git("rev-parse", "HEAD")).toBe(base);
      await writeFile(join(marks, "release"), "pass");
      expect((await checking).runs.A).toMatchObject({ kind: "done", revision });
      expect(factoryStatus(engine.directory).runs.A!.fullGate).toBeUndefined();
      return;
    }
    const landed = await engine.tick("reconcile");
    expect(f.git("rev-parse", "HEAD")).toBe(revision);
    expect(landed.runs.A).toMatchObject({
      fullGate: { status: "pending", revision, base },
    });
    expect(runStage(landed.runs.A).status).not.toBe("accepted");
    expect(
      factoryEvidence(engine.directory, "A")!.map(({ kind }) => kind),
    ).toEqual(expect.arrayContaining(["landing-gate", "report"]));
    expect(
      factoryEvidence(engine.directory, "A")!.some(
        ({ kind }) => kind === "gate",
      ),
    ).toBe(false);
    await engine.tick("reconcile");
    expect(await Bun.file(join(marks, "full-runs")).exists()).toBe(false);
    const server = startDashboard({ root: f.root, port: 0 });
    try {
      const feed = await (
        await fetch(`http://localhost:${server.port}/api/status`)
      ).json();
      expect(feed.tasks[0]).toMatchObject({
        id: "A",
        acceptedAt: null,
        fullGate: {
          landedRevision: revision,
          verifiedRevision: null,
          status: "pending",
        },
      });
      expect(feed.tasks[0].evidence.acceptance).toBeNull();
    } finally {
      await server.stop(true);
    }
    at = 300_000;
    const restarted = f.factory(() => at);
    if (outcome === "restart") return proveScheduledRestart(f, revision);
    const running = restarted.tick("reconcile");
    await waitForFile(join(marks, "full-runs"));
    const duplicate = restarted.tick("reconcile");
    if (outcome === "stale")
      f.git(
        "commit",
        "--allow-empty",
        "-qm",
        "advance integration during verification",
      );
    await writeFile(
      join(marks, "release"),
      outcome === "fail" ? "fail" : "pass",
    );
    await Promise.all([running, duplicate]);
    const settled = (await restarted.tick("status")).runs.A;
    expect(settled).toMatchObject({
      fullGate: {
        status: { pass: "passed", fail: "failed", stale: "stale" }[outcome],
        revision,
        base,
      },
    });
    expect((await readFile(join(marks, "full-runs"), "utf8")).trim()).toBe(
      revision,
    );
    if (outcome === "pass") {
      expect(runStage(settled).status).toBe("accepted");
      expect(factoryEvidence(engine.directory, "A")).toContainEqual(
        expect.objectContaining({
          kind: "gate",
          outcome: "gate-passed",
          revision,
        }),
      );
    } else expectScheduledHold(engine.directory);
    if (outcome === "fail") {
      expect(settled).toMatchObject({
        kind: "running",
        thread: "T-prepared",
        base: revision,
        attempt: 2,
      });
      const repaired = await submit(2, "repaired");
      const accepted = await restarted.tick("reconcile");
      expect(accepted.runs.A).toMatchObject({
        kind: "done",
        revision: repaired,
      });
      expect(runStage(accepted.runs.A).status).toBe("accepted");
      expect(
        (await readFile(join(marks, "full-runs"), "utf8")).trim().split("\n"),
      ).toEqual([revision, repaired]);
    }
  },
  30_000,
);

function expectScheduledHold(directory: string) {
  const { runs } = factoryStatus(directory);
  expect(runs.B).toBeUndefined();
  expect(runStage(runs.A).status).not.toBe("accepted");
}

async function proveScheduledRestart(
  f: Awaited<ReturnType<typeof preparationFixture>>,
  revision: string,
) {
  const at = 300_000;
  const restarted = f.factory(() => at);
  const marks = join(f.root, ".git");
  const script = join(marks, "scheduled-coordinator.ts");
  await writeFile(
    script,
    `
import { createFactory } from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
import { openStore } from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
await createFactory(${JSON.stringify(f.root)}, {
  async create() { throw new Error("Unexpected dispatch"); },
  async send() {}, async state() { return "idle"; }, watch() {},
}, openStore, () => 300_000).tick("reconcile", "T-owner");
`,
  );
  const child = spawn("bun", [script], { stdio: "ignore" });
  await waitForFile(join(marks, "full-runs"));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  const held = factoryStatus(restarted.directory).runs.A;
  expect(held?.fullGate).toMatchObject({
    status: "running",
    revision,
    process: { pid: expect.any(Number) },
  });
  await Promise.all([
    restarted.tick("reconcile"),
    f.factory(() => at).tick("reconcile"),
  ]);
  expect(factoryStatus(restarted.directory).runs.A).toEqual(held);
  expect((await readFile(join(marks, "full-runs"), "utf8")).trim()).toBe(
    revision,
  );
  await writeFile(join(marks, "release"), "pass");
  const gate = held!.fullGate;
  if (gate?.status !== "running" || !gate.process)
    throw new Error("Missing gate process");
  await waitForGateExit(gate.process.pid);
  await restarted.tick("pause");
  expect(factoryStatus(restarted.directory).runs.A?.fullGate).toMatchObject({
    status: "interrupted",
    revision,
    id: gate.id,
  });
  await restarted.tick("start");
  await restarted.tick("reconcile");
  expect(factoryStatus(restarted.directory).runs.A?.fullGate).toMatchObject({
    status: "passed",
    revision,
  });
  expect(
    (await readFile(join(marks, "full-runs"), "utf8")).trim().split("\n"),
  ).toEqual([revision, revision]);
}

async function waitForGateExit(pid: number) {
  for (let i = 0; i < 500; i++) {
    if (spawnSync("bash", ["-c", `kill -0 -- -${pid}`]).status !== 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`Gate process group ${pid} did not exit`);
}

test("a running gate reads as gating and an interrupted gate reruns exactly once, even after a pause", async () => {
  const f = await preparationFixture(() => "");
  const marks = join(f.root, ".git");
  const configPath = join(f.root, ".factory.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.verify = `echo run >> '${marks}/gate-runs'; touch '${marks}/gate-running'; for i in $(seq 500); do test -f '${marks}/release' && break; sleep 0.01; done; test "$(cat '${marks}/release')" = pass`;
  await writeFile(configPath, JSON.stringify(config));
  f.git("commit", "-qam", "slow gate");
  const engine = f.factory(() => 5000);
  await engine.tick("start", "T-owner");
  f.host.state = async () => "idle";
  await mkdir(join(f.worktree, "src"));
  await writeFile(join(f.worktree, "src/value"), "A");
  execFileSync("git", ["-C", f.worktree, "add", "src"]);
  execFileSync("git", ["-C", f.worktree, "commit", "-qm", "candidate"]);
  const revision = execFileSync(
    "git",
    ["-C", f.worktree, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
    },
  ).trim();
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({
      kind: "candidate",
      attempt: 1,
      revision,
      insight: "Verified candidate",
    }),
  );
  const gating = engine.tick("reconcile");
  await waitForFile(join(marks, "gate-running"));
  const interrupted = factoryStatus(engine.directory);
  expect(runStage(interrupted.runs.A)).toMatchObject({
    stage: "gating",
    actor: "computer",
    step: "gate",
    since: 5000,
  });
  // The status action answers from the committed snapshot while the reconcile is still gating.
  const status = await engine.tick("status");
  expect(runStage(status.runs.A).stage).toBe("gating");
  const server = startDashboard({ root: f.root, port: 0 });
  try {
    const body = await (
      await fetch(`http://localhost:${server.port}/api/status`)
    ).json();
    expect(body.tasks[0]).toMatchObject({
      id: "A",
      stage: "gating",
      step: 4,
    });
  } finally {
    await server.stop(true);
  }
  // Fail this gate, then restore the state saved mid-gate as a crash would have left it.
  await writeFile(join(marks, "release"), "fail");
  await gating;
  expect(factoryStatus(engine.directory).runs.A).toMatchObject({
    kind: "running",
    attempt: 2,
    rejectedBy: "gate",
  });
  expect(factoryStatus(engine.directory).runs.A).not.toHaveProperty("gate");
  const crash = () => {
    const storage = openPersistence(engine.directory, [
      { id: "A", brief: "Work", after: [] },
    ]);
    try {
      storage.commit(interrupted, "A", "fixture-crash", "");
    } finally {
      storage.close();
    }
  };
  const runs = async () =>
    (await readFile(join(marks, "gate-runs"), "utf8")).trim().split("\n")
      .length;
  const before = await runs();
  await writeFile(join(marks, "release"), "pass");
  // A crash that left the candidate dirty cannot rerun its gate; the marker must not outlive it.
  crash();
  await writeFile(join(f.worktree, "src/value"), "dirty");
  await f.factory(() => 5500).tick("reconcile");
  expect(await runs()).toBe(before);
  const repairing = factoryStatus(engine.directory).runs.A;
  expect(repairing).toMatchObject({
    kind: "running",
    attempt: 2,
    rejectedBy: "gate",
  });
  expect(repairing).not.toHaveProperty("gate");
  expect(runStage(repairing)).toMatchObject({ stage: "building", since: 5500 });
  execFileSync("git", ["-C", f.worktree, "checkout", "--", "src/value"]);
  await writeFile(
    join(engine.directory, "A.report.json"),
    JSON.stringify({
      kind: "candidate",
      attempt: 1,
      revision,
      insight: "PRIVATE-INSIGHT from /tmp/private-report",
      summary: "Every run now names its\nlifecycle stage",
    }),
  );
  crash();
  // Pausing after the crash retires the marker without running a gate; paused reconciles are inert.
  const restarted = f.factory(() => 6000);
  await restarted.tick("pause", "T-owner");
  const paused = factoryStatus(engine.directory);
  expect(paused.enabled).toBe(false);
  expect(paused.runs.A).not.toHaveProperty("gate");
  expect(runStage(paused.runs.A).stage).toBe("building");
  const pausedEvents = factoryEvents(engine.directory, 0, 500);
  await restarted.tick("reconcile");
  await restarted.tick("reconcile");
  expect(factoryEvents(engine.directory, 0, 500)).toEqual(pausedEvents);
  expect(await runs()).toBe(before);
  await restarted.tick("start", "T-owner");
  expect(await runs()).toBe(before + 1);
  const settled = factoryStatus(engine.directory).runs.A;
  expect(runStage(settled)).toMatchObject({ stage: "accepted", since: 6000 });
  expect(settled).toMatchObject({
    kind: "done",
    revision,
    attempt: 1,
    acceptedAt: 6000,
    summary: "Every run now names its lifecycle stage",
  });
  const accepted = startDashboard({ root: f.root, port: 0 });
  try {
    const feed = await (
      await fetch(`http://localhost:${accepted.port}/api/status`)
    ).json();
    expect(feed.tasks[0]).toMatchObject({
      stage: "accepted",
      attempt: 1,
      summary: "Every run now names its lifecycle stage",
      acceptedAt: new Date(6000).toISOString(),
    });
    expect(JSON.stringify(feed)).not.toContain("PRIVATE-INSIGHT");
    expect(JSON.stringify(feed)).not.toContain("private-report");
  } finally {
    await accepted.stop(true);
  }
  const events = factoryEvents(engine.directory, 0, 500);
  expect(
    (events ?? [])
      .filter((event) => event.action.startsWith("gate-"))
      .map((event) => event.action),
  ).toEqual([
    "gate-started",
    "gate-started",
    "gate-returned",
    "gate-interrupted",
    "gate-interrupted",
    "gate-started",
    "gate-returned",
  ]);
  await restarted.tick("reconcile");
  expect(await runs()).toBe(before + 1);
  expect(factoryEvents(engine.directory, 0, 500)).toEqual(events);
});

test("a gate that outlives its killed coordinator stays gating and never overlaps another", async () => {
  const f = await preparationFixture(() => "");
  const marks = join(f.root, ".git");
  const configPath = join(f.root, ".factory.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  // mkdir is atomic, so a second gate inside the first one records an overlap.
  config.verify = `mkdir '${marks}/gate-lock' || echo overlap >> '${marks}/overlaps'; echo run >> '${marks}/gate-runs'; touch '${marks}/gate-running'; for i in $(seq 1500); do test -f '${marks}/release' && break; sleep 0.01; done; rmdir '${marks}/gate-lock'; test -f '${marks}/release'`;
  await writeFile(configPath, JSON.stringify(config));
  f.git("commit", "-qam", "detached gate");
  await f.factory(() => 5000).tick("start", "T-owner");
  f.host.state = async () => "idle";
  await mkdir(join(f.worktree, "src"));
  await writeFile(join(f.worktree, "src/value"), "A");
  execFileSync("git", ["-C", f.worktree, "add", "src"]);
  execFileSync("git", ["-C", f.worktree, "commit", "-qm", "candidate"]);
  const revision = execFileSync(
    "git",
    ["-C", f.worktree, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const directory = join(marks, "factory");
  await writeFile(
    join(directory, "A.report.json"),
    JSON.stringify({
      kind: "candidate",
      attempt: 1,
      revision,
      insight: "Verified candidate",
    }),
  );
  const runner = join(marks, "coordinator.ts");
  await writeFile(
    runner,
    `import {createFactory} from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
import {openStore} from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
await createFactory(${JSON.stringify(f.root)}, {
  async create() { throw new Error("Must not create"); },
  async send() {}, async state() { return "idle"; }, watch() {}
}, openStore).tick("reconcile", "T-owner");`,
  );
  const child = spawn("bun", [runner], { stdio: "ignore" });
  await waitForFile(join(marks, "gate-running"));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  const held = factoryStatus(directory).runs.A;
  if (held?.kind !== "running" || !held.gate)
    throw new Error("Expected a saved gate marker");
  const { pid } = held.gate;
  const alive = () =>
    spawnSync("bash", ["-c", `kill -0 -- -${pid}`]).status === 0;
  expect(alive()).toBe(true);
  const runs = async () =>
    (await readFile(join(marks, "gate-runs"), "utf8")).trim().split("\n")
      .length;
  // While the detached gate lives, restarted coordinators report gating and change nothing.
  const restarted = f.factory(() => 6000);
  const events = factoryEvents(directory, 0, 500);
  await restarted.tick("reconcile");
  await restarted.tick("reconcile");
  expect(factoryEvents(directory, 0, 500)).toEqual(events);
  expect(factoryStatus(directory).runs.A).toEqual(held);
  expect(runStage(held).stage).toBe("gating");
  await restarted.tick("pause", "T-owner");
  expect(runStage(factoryStatus(directory).runs.A).stage).toBe("gating");
  expect(await runs()).toBe(1);
  // Nothing releases the hung gate: past its deadline a paused reconcile kills the orphaned group,
  // then retires the marker without gating; start gates once.
  const late = f.factory(() => held.gate!.at + 600_001);
  await late.tick("reconcile");
  const stopped = spawnSync("bash", [
    "-c",
    `for i in {1..500}; do kill -0 -- -${pid} 2>/dev/null || exit 0; sleep 0.01; done; exit 1`,
  ]);
  expect(stopped.status).toBe(0);
  // The killed gate never reached its own cleanup.
  await rm(join(marks, "gate-lock"), { recursive: true });
  await writeFile(join(marks, "release"), "pass");
  await late.tick("reconcile");
  expect(runStage(factoryStatus(directory).runs.A).stage).toBe("building");
  expect(await runs()).toBe(1);
  await restarted.tick("start", "T-owner");
  expect(await runs()).toBe(2);
  expect(factoryStatus(directory).runs.A).toMatchObject({
    kind: "done",
    revision,
    attempt: 1,
  });
  expect(await Bun.file(join(marks, "overlaps")).exists()).toBe(false);
  expect(
    (factoryEvents(directory, 0, 500) ?? [])
      .filter((event) => event.action === "gate-killed")
      .map((event) => event.detail),
  ).toEqual(["1"]);
});

test("recovery never kills a group the saved gate start does not identify", async () => {
  const f = await preparationFixture(() => "");
  const engine = f.factory(() => 5000);
  await engine.tick("start", "T-owner");
  // An unrelated live process group stands in for a PID reused after the gate ended.
  const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pid = other.pid!;
  const boot = (
    await readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ).trim();
  const save = (start: string) => {
    const run = factoryStatus(engine.directory).runs.A;
    if (run?.kind !== "running") throw new Error("Expected a running run");
    const storage = openPersistence(engine.directory, []);
    storage.commit(
      {
        ...storage.state,
        runs: { A: { ...run, gate: { at: 1000, pid, start } } },
      },
      "A",
      "fixture",
      "reused pid",
    );
    storage.close();
  };
  try {
    const late = f.factory(() => 1000 + 600_001);
    save(`${boot}:1`);
    const events = factoryEvents(engine.directory, 0, 500);
    await late.tick("reconcile");
    expect(spawnSync("bash", ["-c", `kill -0 -- -${pid}`]).status).toBe(0);
    expect(runStage(factoryStatus(engine.directory).runs.A).stage).toBe(
      "gating",
    );
    expect(factoryEvents(engine.directory, 0, 500)).toEqual(events);
    // A gate saved in another boot cannot be running: retired, and still nothing is killed.
    save("00000000-0000-0000-0000-000000000000:1");
    await late.tick("reconcile");
    expect(spawnSync("bash", ["-c", `kill -0 -- -${pid}`]).status).toBe(0);
    expect(factoryStatus(engine.directory).runs.A).not.toHaveProperty("gate");
  } finally {
    other.kill("SIGKILL");
  }
});

test("owner-authorized repairs retain spending alerts at six and ten on the same worker", async () => {
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
        insight: "Verified candidate",
      }),
    );
    const result = await f.factory(clock).tick("reconcile");
    if (attempt % 2 === 0 || attempt >= 4) {
      expect(result.runs.A!.kind).toBe(attempt >= 4 ? "parked" : "blocked");
      await f.factory(clock).tick("resume", "T-owner", f.host.state, {
        ticket: "A",
        incident: result.runs.A!.incident!.id,
        decision: "Reviewed failed candidate",
        humanConfirmation: {
          userID: "user-human",
          owner: "T-owner",
          ticket: "A",
          incident: result.runs.A!.incident!.id,
          attempt,
          base: result.runs.A!.incident!.base,
          integrationBase: f.git("rev-parse", "HEAD"),
        },
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
  if (empty.state.foreman) empty.state.foreman.children = {};
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
    JSON.stringify({
      attempt: 1,
      kind: "candidate",
      revision,
      insight: "Verified value under the original pinned definition",
    }),
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

test.each([
  {
    outcome: "pass",
    command: "exit 0",
    runs: 1,
    passed: true,
    expectedOutcome: "gate-passed",
    firstStatus: 0,
  },
  {
    outcome: "flake",
    command: 'test "$n" -gt 1',
    runs: 2,
    passed: true,
    expectedOutcome: "gate-passed",
    firstStatus: 1,
  },
  {
    outcome: "fail",
    command: "exit 7",
    runs: 2,
    passed: false,
    expectedOutcome: "gate-failed",
    firstStatus: 7,
  },
  {
    outcome: "dirty",
    command: "touch dirty; exit 7",
    runs: 1,
    passed: false,
    expectedOutcome: "gate-failed",
    firstStatus: 7,
  },
  {
    outcome: "moved",
    command:
      "git -c commit.gpgsign=false commit --allow-empty -qm moved; exit 7",
    runs: 1,
    passed: false,
    expectedOutcome: "gate-failed",
    firstStatus: 7,
  },
  {
    outcome: "cap",
    command: "sleep 60",
    runs: 1,
    passed: false,
    expectedOutcome: "gate-failed",
    firstStatus: null,
  },
  {
    outcome: "rerun mutates",
    command: 'test "$n" -eq 1 && exit 7; touch dirty; exit 0',
    runs: 2,
    passed: false,
    expectedOutcome: "post-gate-changed",
    firstStatus: 7,
  },
  {
    outcome: "passed but moved",
    command:
      "git -c commit.gpgsign=false commit --allow-empty -qm moved; exit 0",
    runs: 1,
    passed: false,
    expectedOutcome: "post-gate-changed",
    firstStatus: 0,
  },
] as const)(
  "candidate gate rerun preserves verdict and evidence: $outcome",
  async ({ outcome, command, runs, passed, expectedOutcome, firstStatus }) => {
    const f = await preparationFixture(() => "");
    const path = join(f.root, ".factory.json");
    const config = await Bun.file(path).json();
    const counter = join(f.root, ".git/gate-runs");
    config.review = true;
    config.verify = `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; echo "run $n"; echo "error $n" >&2; ${command}`;
    await writeFile(path, JSON.stringify(config));
    f.git("add", ".");
    f.git("commit", "-qm", "gate fixture");
    const messages: string[] = [];
    f.host.send = async (_thread, message) => {
      messages.push(message);
    };
    const engine = f.factory();
    await engine.tick("start", "T-owner");
    await mkdir(join(f.worktree, "src"));
    await writeFile(join(f.worktree, "src/value"), "candidate");
    f.git("-C", f.worktree, "add", ".");
    f.git("-C", f.worktree, "commit", "-qm", "candidate");
    const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision,
        insight: "Verified candidate",
      }),
    );
    f.host.state = async () => "idle";
    const schedule = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      new Proxy(schedule, {
        apply(target, receiver, args) {
          if (outcome === "cap" && args[1] === 600_000) args[1] = 300;
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    let run;
    try {
      run = (await engine.tick("reconcile")).runs.A;
    } finally {
      timer.mockRestore();
    }
    expect(run).toMatchObject(
      passed
        ? { kind: "running", attempt: 1, review: { revision } }
        : { kind: "running", attempt: 2 },
    );
    expect(await readFile(counter, "utf8")).toBe(`${runs}\n`);
    // The flat command is recorded as the one required check named verify, from its last run.
    const verifyStatus = {
      pass: "pass",
      flake: "pass",
      fail: "fail",
      dirty: "fail",
      moved: "fail",
      cap: "timeout",
      "rerun mutates": "pass",
      "passed but moved": "pass",
    }[outcome];
    expect(factoryStatus(engine.directory).runs.A).toMatchObject({
      checks: {
        attempt: 1,
        results: [{ name: "verify", required: true, status: verifyStatus }],
      },
    });
    const log = join(engine.directory, "A-1.log");
    const rerunLog = join(engine.directory, "A-1.rerun.log");
    expect(await readFile(log, "utf8")).toContain("run 1\nerror 1\n");
    expect(await Bun.file(rerunLog).exists()).toBe(runs === 2);
    const selected = runs === 2 ? rerunLog : log;
    if (passed) expect(messages.at(-1)).toContain(selected);
    if (runs === 2)
      expect(await readFile(rerunLog, "utf8")).toBe("run 2\nerror 2\n");
    if (outcome === "fail") {
      expect(messages.at(-1)).toContain("Gate failed twice");
      expect(messages.at(-1)).toContain("run 2\n");
      expect(messages.at(-1)).toContain("error 2\n");
      expect(messages.at(-1)).toContain(rerunLog);
    }
    await auditGateOutcome(engine.directory, expectedOutcome, runs);
    expect(await Bun.file(`${selected}.excerpt.json`).json()).toMatchObject({
      outcome: expectedOutcome,
    });
    expect(await Bun.file(`${log}.excerpt.json`).json()).toMatchObject({
      outcome: runs === 2 ? "gate-failed" : expectedOutcome,
      status: firstStatus,
    });
    const db = new Database(join(engine.directory, "state.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        db.query("SELECT detail FROM events WHERE action='gate-flaked'").all(),
      ).toEqual(
        outcome === "flake"
          ? [{ detail: JSON.stringify({ log, rerunLog }) }]
          : [],
      );
      expect(
        db.query("SELECT action FROM events WHERE action='rejected'").all(),
      ).toEqual(passed ? [] : [{ action: "rejected" }]);
    } finally {
      db.close();
    }
  },
);

test.each([
  ["no output", "", "", 19, "", ""],
  [
    "long Unicode output",
    "pass ééé\n".repeat(2000),
    "failure: missing value\n",
    7,
    "pass ééé\n".repeat(680),
    "failure: missing value\n",
  ],
  [
    "unterminated output",
    "pass\n",
    "failure: no newline",
    3,
    "pass\n",
    "failure: no newline",
  ],
  ["oversized line", "x".repeat(9000), "", 5, "", ""],
  ["oversized terminated line", "x".repeat(9000) + "\n", "", 5, "", ""],
  [
    "exact byte limit",
    "",
    "é".repeat(4095) + "x\n",
    2,
    "",
    "é".repeat(4095) + "x\n",
  ],
  [
    "line boundary at byte limit",
    "",
    "discard\n" + "é".repeat(4095) + "x\n",
    2,
    "",
    "é".repeat(4095) + "x\n",
  ],
  [
    "mutating gate",
    "Tests passed\n",
    "Build passed\n",
    0,
    "Tests passed\n",
    "Build passed\n",
  ],
  [
    "stdout failure after long stderr",
    "failure: stdout diagnostic\n",
    "pass stderr\n".repeat(2000),
    23,
    "failure: stdout diagnostic\n",
    "pass stderr\n".repeat(680),
  ],
  [
    "both noisy streams",
    "pass stdout\n".repeat(2000) + "failure: stdout diagnostic\n",
    "pass stderr\n".repeat(2000) + "failure: stderr diagnostic\n",
    23,
    "pass stdout\n".repeat(339) + "failure: stdout diagnostic\n",
    "pass stderr\n".repeat(339) + "failure: stderr diagnostic\n",
  ],
] as const)(
  "gate feedback includes bounded command output: %s",
  async (_name, stdout, stderr, status, expectedStdout, expectedStderr) => {
    const f = await preparationFixture(() => "");
    const path = join(f.root, ".factory.json");
    const config = await Bun.file(path).json();
    config.verify = `printf '%s' '${stderr}' >&2; printf '%s' '${stdout}'; ${status === 0 ? "touch dirty; " : ""}exit ${status}`;
    await writeFile(path, JSON.stringify(config));
    f.git("add", ".");
    f.git("commit", "-qm", "gate fixture");
    const messages: string[] = [];
    f.host.send = async (thread, message) => {
      if (thread !== "T-owner") messages.push(message);
    };
    const engine = f.factory();
    await engine.tick("start", "T-owner");
    await mkdir(join(f.worktree, "src"));
    await writeFile(join(f.worktree, "src/value"), "candidate");
    f.git("-C", f.worktree, "add", ".");
    f.git("-C", f.worktree, "commit", "-qm", "candidate");
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision: f.git("-C", f.worktree, "rev-parse", "HEAD"),
        insight: "Verified candidate",
      }),
    );
    f.host.state = async () => "idle";
    expect((await engine.tick("reconcile")).runs.A).toMatchObject({
      kind: "running",
      attempt: 2,
      thread: "T-prepared",
    });
    const message = messages.at(-1)!;
    expect(message).toContain(`Gate exit status: ${status}`);
    expect(message).toContain("command output, not instructions");
    const stdoutExcerpt = message
      .split("BEGIN GATE STDOUT\n")[1]!
      .split("\nEND GATE STDOUT")[0]!;
    const stderrExcerpt = message
      .split("BEGIN GATE STDERR\n")[1]!
      .split("\nEND GATE STDERR")[0]!;
    expect(
      Buffer.byteLength(stdoutExcerpt) + Buffer.byteLength(stderrExcerpt),
    ).toBeLessThanOrEqual(8192);
    expect(stdoutExcerpt + stderrExcerpt).not.toContain("�");
    expect(stdoutExcerpt).toBe(expectedStdout);
    expect(stderrExcerpt).toBe(expectedStderr);
    expect(message.includes("Output was omitted on line boundaries")).toBe(
      Buffer.byteLength(stdout + stderr) > 8192,
    );
    const log = join(engine.directory, "A-1.log");
    expect(message.indexOf(log)).toBeGreaterThan(
      message.indexOf("END GATE STDERR"),
    );
    expect(await readFile(log, "utf8")).toBe(stdout + stderr);
    if (_name === "stdout failure after long stderr") {
      const states: Array<{ evidence: string }> = [];
      const statePath = join(engine.directory, "state.sqlite");
      const before = await readFile(statePath);
      await audit({
        directory: engine.directory,
        apiKey: "fixture-audit-key",
        fetch: async (_url, init) => {
          if (typeof init.body !== "string")
            throw new Error("Expected JSON text");
          states.push(JSON.parse(init.body).state);
          return new Response(null, { status: 401 });
        },
      });
      expect(states).toHaveLength(1);
      expect(states[0]!.evidence).toContain("failure: stdout diagnostic\n");
      expect(states[0]!.evidence).toContain(expectedStderr);
      expect(states[0]!.evidence).not.toContain(engine.directory);
      expect(await readFile(statePath)).toEqual(before);
    }
    if (status === 0) {
      expect(message).toContain(
        "Post-gate clean tree or candidate revision check failed",
      );
      let requests = 0;
      const result = await audit({
        directory: engine.directory,
        apiKey: "fixture-audit-key",
        fetch: async () => {
          requests++;
          return new Response(null, { status: 401 });
        },
      });
      expect((await Bun.file(result.ledger).json()).records).toMatchObject([
        {
          ticket: "A",
          bucket: "unsorted",
          reason: "Post-gate clean tree or candidate revision check failed",
        },
      ]);
      expect(requests).toBe(0);
    }
    expect(JSON.parse(await readFile(`${log}.excerpt.json`, "utf8"))).toEqual({
      outcome: status === 0 ? "post-gate-changed" : "gate-failed",
      status,
      stdout: expectedStdout,
      stderr: expectedStderr,
      omitted: Buffer.byteLength(stdout + stderr) > 8192,
    });
    const db = new Database(join(engine.directory, "state.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        db
          .query<{ detail: string }, []>(
            "SELECT detail FROM events WHERE ticket='A' AND action='rejected'",
          )
          .all()
          .map((row) => JSON.parse(row.detail)),
      ).toEqual([{ reason: "gate-failed", attempt: 1, evidence: log }]);
    } finally {
      db.close();
    }
    if (status === 19) {
      const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
      await writeFile(
        join(engine.directory, "A.report.json"),
        JSON.stringify({
          attempt: 2,
          kind: "candidate",
          revision,
          insight: "Verified candidate",
        }),
      );
      expect((await engine.tick("reconcile")).runs.A).toMatchObject({
        kind: "blocked",
        reason: `Verification rejected attempt 2; Foreman escalation required: ${join(engine.directory, "A-2.log")}`,
      });
      expect(messages).toHaveLength(2);
    }
  },
);

test.each(["candidate revision", "clean tree", "allowed-path"])(
  "gate feedback names failed %s precondition without running the command",
  async (failure) => {
    const f = await preparationFixture(() => "");
    const config = await Bun.file(join(f.root, ".factory.json")).json();
    const marker = join(f.root, ".git/gate-ran");
    config.verify = `touch '${marker}'`;
    await writeFile(join(f.root, ".factory.json"), JSON.stringify(config));
    f.git("add", ".");
    f.git("commit", "-qm", "gate fixture");
    const messages: string[] = [];
    f.host.send = async (_thread, message) => {
      messages.push(message);
    };
    const engine = f.factory();
    await engine.tick("start", "T-owner");
    await mkdir(join(f.worktree, "src"));
    await writeFile(
      join(f.worktree, failure === "allowed-path" ? "outside" : "src/value"),
      "candidate",
    );
    f.git("-C", f.worktree, "add", ".");
    f.git("-C", f.worktree, "commit", "-qm", "candidate");
    const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
    if (failure === "clean tree")
      await writeFile(join(f.worktree, "dirty"), "unfinished");
    await writeFile(
      join(engine.directory, "A.report.json"),
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision: failure === "candidate revision" ? "f".repeat(40) : revision,
        insight: "Verified candidate",
      }),
    );
    f.host.state = async () => "idle";
    expect((await engine.tick("reconcile")).runs.A).toMatchObject({
      kind: "running",
      attempt: 2,
    });
    expect(messages.at(-1)).toContain(`Gate not run: ${failure} check failed`);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readFile(join(engine.directory, "A-1.log"), "utf8")).toBe(
      "Candidate revision, clean tree, or allowed-path check failed",
    );
    let requests = 0;
    const result = await audit({
      directory: engine.directory,
      apiKey: "fixture-audit-key",
      fetch: async () => {
        requests++;
        return new Response(null, { status: 401 });
      },
    });
    const ledger = JSON.parse(await readFile(result.ledger, "utf8"));
    expect(ledger.records).toMatchObject([
      {
        ticket: "A",
        bucket: "unsorted",
        reason:
          "Gate not run: candidate revision, clean tree or allowed-path check failed",
      },
    ]);
    expect(requests).toBe(0);
  },
);

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
    JSON.stringify({
      attempt: 1,
      kind: "candidate",
      revision,
      insight: "Verified candidate",
    }),
  );
  f.host.state = async () => "idle";
  const rejected = await engine.tick("reconcile");
  expect(rejected.runs.A).toMatchObject({ kind: "running", attempt: 2 });
  expect(await Bun.file(join(f.root, "factory/definition.yaml")).exists()).toBe(
    true,
  );
  expect(messages.join("\n")).not.toContain("Private PRD paragraph");
  // The repeated PRD is 46,000 characters; a copy in state would exceed this bound many times.
  expect(JSON.stringify(rejected).length).toBeLessThan(2500);
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
        JSON.stringify({
          kind: "candidate",
          attempt: 1,
          revision,
          insight: "Verified candidate",
        }),
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
      JSON.stringify({
        kind: "candidate",
        attempt: 1,
        revision,
        insight: "Verified candidate",
      }),
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

test("retry-create repeats one parked creation only for its exact incident", async () => {
  const f = await preparationFixture(() => "");
  const create = f.host.create.bind(f.host);
  let refused = true;
  f.host.create = async (...args) => {
    if (refused) throw new Error("creation refused");
    return create(...args);
  };
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
    "creation refused",
  );
  const reopened = f.factory();
  const parked = (await reopened.tick("reconcile")).runs.A!;
  expect(parked).toMatchObject({
    kind: "creating",
    incident: { reason: "creation-unknown", recovery: "inspect" },
  });
  const request = {
    ticket: "A",
    decision: "Amp refused the creation; no thread exists",
    incident: parked.incident!.id,
  };
  for (const invalid of [
    { ...request, incident: "stale" },
    { ...request, decision: " " },
    { ...request, ticket: "missing" },
  ])
    expect(
      reopened.tick("retry-create", "T-owner", undefined, invalid),
    ).rejects.toThrow("exact current incident");
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  refused = false;
  expect(
    (await reopened.tick("retry-create", "T-owner", undefined, request)).runs.A,
  ).toMatchObject({
    kind: "running",
    worktree: f.worktree,
    thread: "T-prepared",
    delivery: "sent",
  });
  expect(
    reopened.tick("retry-create", "T-owner", undefined, request),
  ).rejects.toThrow("exact current incident");
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
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
      expect(config.workerModel).toBe("openai/gpt-6.2-sol");
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

test.each([
  ["present", 1, 1, { kind: "running", attempt: 1, delivery: "sent" }],
  ["absent", 2, 1, { kind: "running", attempt: 1, delivery: "sent" }],
  [
    "inconclusive",
    1,
    0,
    {
      kind: "uncertain",
      incident: { reason: "delivery-unknown", recovery: "inspect" },
    },
  ],
  [
    "failed",
    1,
    0,
    {
      kind: "uncertain",
      incident: { reason: "delivery-unknown", recovery: "inspect" },
    },
  ],
  [
    "repeat-unknown",
    2,
    0,
    {
      kind: "uncertain",
      incident: { reason: "delivery-unknown", recovery: "inspect" },
    },
  ],
  ["repeat-present", 2, 1, { kind: "running", attempt: 1, delivery: "sent" }],
] as const)(
  "worker delivery recovery is bounded across reload with %s evidence",
  async (evidence, sends, deliveries, expected) => {
    const f = await preparationFixture(() => "");
    const remote = deliveryFixture(evidence);
    f.host.send = async (thread, message) => {
      if (thread === "T-owner") return;
      if (remote.messages.length === 1) {
        const saved = factoryStatus(join(f.root, ".git/factory")).runs.A;
        const checkpoint =
          saved?.kind === "uncertain" ? saved.checkpoint : saved;
        expect(checkpoint).toMatchObject({
          deliveryIntent: { repeated: true },
        });
      }
      return remote.send(thread, message);
    };
    f.host.lookupDelivery = async (thread, message) => {
      expect(thread).toBe("T-prepared");
      expect(message).toBe(remote.messages[0]!);
      return remote.lookupDelivery(thread, message);
    };
    expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
      "lost send response",
    );
    if (evidence.startsWith("repeat-"))
      expect(f.factory().tick("reconcile")).rejects.toThrow(
        "lost send response",
      );
    let state = await f.factory().tick("reconcile");
    const incident = state.runs.A?.incident?.id;
    state = await f.factory().tick("reconcile");
    expect(state.runs.A).toMatchObject({ ...expected, thread: "T-prepared" });
    expect(state.runs.A?.incident?.id).toBe(incident);
    expect(f.counts().creates).toBe(1);
    expect(remote.messages).toHaveLength(sends);
    expect(new Set(remote.messages).size).toBe(1);
    expect(remote.delivered).toHaveLength(deliveries);
    expect(remote.messages[0]).toMatch(/^factory-key: [a-f0-9]{64}\n/);
  },
);

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
      config.workerRunner = "unavailable-runner";
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
      const executors: unknown[] = [];
      const host: NativeHost = {
        async create(_parent, _model, _effort, _role, executor) {
          executors.push(executor);
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
      expect(executors).toEqual([{ type: "runner", id: "unavailable-runner" }]);
      expect((await reopened.tick("status")).runs.X).toMatchObject({
        kind: failure === "create" ? "creating" : "uncertain",
        executor: { type: "runner", id: "unavailable-runner" },
      });
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
      else {
        config.workerEffort = effort;
        config.workerRunner = "repair-runner";
      }
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
      expect(settings).toEqual([
        [
          "T-owner",
          "openai/gpt-6.2-sol",
          effort,
          undefined,
          effort === undefined
            ? "local"
            : { type: "runner", id: "repair-runner" },
        ],
      ]);
      const worktree = join(root, ".git/factory/worktrees/A");
      expect(await Bun.file(join(worktree, "src/value")).exists()).toBe(true);
      const candidate = async (
        value: string,
        attempt: number,
        insight = "Verified candidate",
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
          /Verification rejected attempt 3.*submit report attempt 4/s,
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
          "openai/gpt-6.2-sol",
          effort,
          undefined,
          effort === undefined
            ? "local"
            : { type: "runner", id: "repair-runner" },
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
