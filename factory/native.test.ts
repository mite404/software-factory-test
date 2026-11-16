import { afterEach, expect, spyOn, test } from "bun:test";
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
  migrateDefinition,
  tasks,
  type NativeHost,
} from "./native";
import {
  deliveryFixture,
  openStore,
  watchdogFixture,
} from "./bookkeeping.fixture";
import { startDashboard } from "./dashboard";
import { audit } from "./audit";
import {
  factoryDefinition,
  factoryEvents,
  factoryRecords,
  factoryStatus,
  openPersistence,
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
  const { tools } = watchdogFixture();
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
    counts: () => ({ creates, sends }),
  };
}

afterEach(async () => {
  for (const root of preparationRoots.splice(0))
    await rm(root, { recursive: true, force: true });
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
    }
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
  const report = { attempt: running.attempt, kind: "candidate", revision };
  const reportPath = join(engine.directory, "A.report.json");
  await writeFile(reportPath, JSON.stringify(report));
  f.host.state = async () => "idle";
  if (targetChanged) {
    f.git("commit", "--allow-empty", "-qm", "move integration target");
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
  const landed = await engine.recordLanding(request, "T-owner");
  expect(landed.enabled).toBe(false);
  expect(landed.runs.A).toMatchObject({
    kind: "done",
    thread: running.thread,
    acceptedBase: running.base,
    revision: request.revision,
    merge: { pr: request.pr, commit: request.commit },
    workerModel: "openai/gpt-6.1-sol",
  });
  expect(f.counts()).toEqual(counts);
  const after = await snapshot();
  expect(await f.factory().recordLanding(request, "T-owner")).toEqual(landed);
  expect(await snapshot()).toEqual(after);
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
  ["openai/gpt-6.1-sol", "anthropic/claude-fable-5-2"],
  ["anthropic/claude-fable-5-2", "openai/gpt-6-astra"],
  ["openai/gpt-6.1-sol", "openrouter/openai/gpt-6-astra"],
  ["anthropic/claude-fable-5-2", "amp/claude-fable-5-2"],
  ["anthropic/claude-fable-5-2", "fireworks-ai/claude-fable-5-2"],
  ["openai/gpt-6.1-sol", "baseten/openai/gpt-6-astra"],
  ["openai/gpt-6.1-sol", "google-vertex/claude-fable-5-2"],
  ["openrouter/openai/gpt-6.1-sol", "anthropic/claude-fable-5-2"],
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
      workerModel: "openai/gpt-6.1-sol",
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
      workerModel: "openai/gpt-6.1-sol",
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
    expect(stopped).toMatchObject({ kind: "blocked", incident: { reason } });
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
    ).toMatchObject({ id: "A", status: "planned", outcome: "Safe outcome" });
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
    ).toMatchObject({ status: "accepted", outcome: "Safe outcome", revision });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
  } finally {
    await server.stop();
  }
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
      JSON.stringify({ attempt: 1, kind: "candidate", revision }),
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
          .query(
            "SELECT detail FROM events WHERE ticket='A' AND action='rejected'",
          )
          .all(),
      ).toEqual([{ detail: log }]);
    } finally {
      db.close();
    }
    if (status === 19) {
      const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
      await writeFile(
        join(engine.directory, "A.report.json"),
        JSON.stringify({ attempt: 2, kind: "candidate", revision }),
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
        revision: failure === "candidate revision" ? "wrong" : revision,
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
          "openai/gpt-6.1-sol",
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
          "openai/gpt-6.1-sol",
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
