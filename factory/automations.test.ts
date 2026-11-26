import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, watchdogFixture } from "./bookkeeping.fixture";
import { reconcileSchedule } from "./watchdog";
import { lastFire, shortestGapMinutes, validCron } from "./cron";
import {
  configuration,
  createFactory,
  effectiveConfiguration,
  type NativeHost,
} from "./native";
import {
  factoryDefinition,
  factoryEvents,
  factoryStatus,
  factoryRecords,
  enqueueAutomationRequest,
  openPersistence,
  type State,
} from "./persistence";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const model = "anthropic/claude-opus-5-5";
const factoryYaml = `version: 1
capacity: 1
prd: prd.md
tickets: tickets.json
scope:
  - src/
verify: "true"
permissions:
  execute: true
  publish: false
  externalTickets: false
`;
const base: Record<string, string> = {
  "factory.yaml": factoryYaml,
  "agents/implementer/agent.md": `---\nmodel: ${model}\neffort: medium\n---\n`,
};
const planned = [
  {
    id: "A",
    brief: "Work",
    after: [],
    intake: "planned",
    outcome: "Planned work",
  },
];
const admitted = [{ id: "A", brief: "Work", after: [] }];

// UTC wall time on the fixture's day, which is a Thursday.
const at = (hour: number, minute: number, day = 19) =>
  Date.UTC(2026, 10, day, hour, minute);

function automationFile(schedule: string, enabled: boolean, body = "Check.") {
  return `---\nschedule: "${schedule}"\nenabled: ${enabled}\n---\n${body}\n`;
}

async function put(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, "factory/config", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

async function repository(tickets: object[] = planned) {
  const root = await mkdtemp(join(tmpdir(), "factory-automations-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  // CI runners have no global Git identity.
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "prd.md"), "Fixture instructions\n");
  await writeFile(join(root, "tickets.json"), JSON.stringify(tickets));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/keep.ts"), "export {};\n");
  return { root, git };
}

// The refusal's message; a promise that resolves fails the test.
async function refused(attempt: Promise<unknown>) {
  try {
    await attempt;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected a refusal");
}

const own = "factory/config/automations";

test("a valid automation loads in path order with enabled off by default and a trimmed prompt", async () => {
  const f = await repository();
  await put(f.root, {
    ...base,
    "automations/weekly/automation.md":
      '---\nschedule: "0 9 * * 1"\n---\n\n  Audit failures.  \n\n',
    "automations/pulse/automation.md": automationFile("*/5 * * * *", true),
  });
  expect((await configuration(f.root)).automations).toEqual([
    { name: "pulse", schedule: "*/5 * * * *", enabled: true, prompt: "Check." },
    {
      name: "weekly",
      schedule: "0 9 * * 1",
      enabled: false,
      prompt: "Audit failures.",
    },
  ]);
});

// Each case names the file in its refusal.
const refusals: [string, (root: string) => Promise<void>, RegExp][] = [
  [
    "automations/ as a link",
    async (root) => {
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await symlink(
        join(root, "elsewhere"),
        join(root, "factory/config/automations"),
      );
    },
    /factory\/config\/automations: must be a regular file/,
  ],
  [
    "an automation directory as a link",
    async (root) => {
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await writeFile(
        join(root, "elsewhere/automation.md"),
        automationFile("*/5 * * * *", true),
      );
      await mkdir(join(root, own), { recursive: true });
      await symlink(join(root, "elsewhere"), join(root, own, "pulse"));
    },
    /automations\/pulse: must be a regular file/,
  ],
  [
    "automation.md as a link",
    async (root) => {
      await mkdir(join(root, "elsewhere"), { recursive: true });
      await writeFile(
        join(root, "elsewhere/real.md"),
        automationFile("*/5 * * * *", true),
      );
      await mkdir(join(root, own, "pulse"), { recursive: true });
      await symlink(
        join(root, "elsewhere/real.md"),
        join(root, own, "pulse/automation.md"),
      );
    },
    /automations\/pulse\/automation\.md: must be a regular file/,
  ],
  [
    "automation.md as a directory",
    async (root) => {
      await mkdir(join(root, own, "pulse/automation.md"), { recursive: true });
    },
    /automations\/pulse\/automation\.md: is not part of the config layout/,
  ],
  [
    "automation.md as a named pipe",
    async (root) => {
      await mkdir(join(root, own, "pulse"), { recursive: true });
      execFileSync("mkfifo", [join(root, own, "pulse/automation.md")]);
    },
    /automations\/pulse\/automation\.md: must be a regular file/,
  ],
  [
    "a stray file in automations/",
    async (root) => put(root, { "automations/notes.md": "hello\n" }),
    /automations\/notes\.md: is not part of the config layout/,
  ],
  [
    "a stray directory in automations/",
    async (root) => {
      await mkdir(join(root, own, ".hidden"), { recursive: true });
    },
    /automations\/\.hidden: is not part of the config layout/,
  ],
  [
    "a stray file in an automation directory",
    async (root) =>
      put(root, {
        "automations/pulse/automation.md": automationFile("*/5 * * * *", true),
        "automations/pulse/notes.md": "hello\n",
      }),
    /automations\/pulse\/notes\.md: is not part of the config layout/,
  ],
  [
    "a stray directory in an automation directory",
    async (root) => {
      await put(root, {
        "automations/pulse/automation.md": automationFile("*/5 * * * *", true),
      });
      await mkdir(join(root, own, "pulse/extra"), { recursive: true });
    },
    /automations\/pulse\/extra: is not part of the config layout/,
  ],
  [
    "an automation directory without automation.md",
    async (root) => {
      await mkdir(join(root, own, "pulse"), { recursive: true });
    },
    /automations\/pulse: has no automation\.md/,
  ],
  [
    "an unknown front matter key",
    async (root) =>
      put(root, {
        "automations/pulse/automation.md":
          '---\nschedule: "*/5 * * * *"\nbogus: 1\n---\nCheck.\n',
      }),
    /automations\/pulse\/automation\.md: unsupported setting bogus/,
  ],
  [
    "a missing schedule",
    async (root) =>
      put(root, {
        "automations/pulse/automation.md": "---\nenabled: true\n---\nCheck.\n",
      }),
    /automations\/pulse\/automation\.md: schedule is required/,
  ],
  [
    "a file without front matter",
    async (root) =>
      put(root, { "automations/pulse/automation.md": "Check.\n" }),
    /automations\/pulse\/automation\.md: schedule is required/,
  ],
  ...[
    ["an empty schedule", '""'],
    ["a null schedule", "null"],
    ["a numeric schedule", "5"],
    ["a four-field schedule", '"* * * *"'],
    ["a six-field schedule", '"0 * * * * *"'],
    ["a minute out of range", '"60 * * * *"'],
    ["a zero step", '"*/0 * * * *"'],
    ["a month name", '"0 0 1 jan *"'],
    ["a date no month has", '"0 0 31 2 *"'],
  ].map(([name, value]): [string, (root: string) => Promise<void>, RegExp] => [
    name!,
    async (root) =>
      put(root, {
        "automations/pulse/automation.md": `---\nschedule: ${value}\n---\nCheck.\n`,
      }),
    /automations\/pulse\/automation\.md: schedule must be a quoted 5-field cron/,
  ]),
  ...["yes", "1", '"true"', "null"].map(
    (value): [string, (root: string) => Promise<void>, RegExp] => [
      `enabled: ${value}`,
      async (root) =>
        put(root, {
          "automations/pulse/automation.md": `---\nschedule: "*/5 * * * *"\nenabled: ${value}\n---\nCheck.\n`,
        }),
      /automations\/pulse\/automation\.md: enabled must be true or false/,
    ],
  ),
  [
    "an empty body",
    async (root) =>
      put(root, {
        "automations/pulse/automation.md":
          '---\nschedule: "*/5 * * * *"\nenabled: true\n---\n \n\n',
      }),
    /automations\/pulse\/automation\.md: the prompt after the front matter is empty/,
  ],
  [
    "front matter that never closes",
    async (root) =>
      put(root, {
        "automations/pulse/automation.md":
          '---\nschedule: "*/5 * * * *"\nCheck.\n',
      }),
    /automations\/pulse\/automation\.md: has malformed front matter/,
  ],
];

test.each(refusals)(
  "refuses %s, naming the file",
  async (_name, arrange, message) => {
    const f = await repository();
    await put(f.root, base);
    await arrange(f.root);
    expect(await refused(configuration(f.root))).toMatch(message);
  },
);

test("refuses automations/ in a project that still uses a flat definition", async () => {
  const f = await repository();
  await writeFile(
    join(f.root, ".factory.json"),
    JSON.stringify({
      version: 1,
      capacity: 1,
      workerModel: model,
      prd: "prd.md",
      tickets: "tickets.json",
      scope: ["src/"],
      verify: "true",
      permissions: { execute: true, publish: false, externalTickets: false },
    }),
  );
  expect((await configuration(f.root)).automations).toEqual([]);
  await mkdir(join(f.root, own), { recursive: true });
  expect(await refused(configuration(f.root))).toMatch(
    /factory\/config\/automations: is not allowed beside a flat definition/,
  );
  await put(f.root, {
    "agents/foreman/agent.md": "# Foreman\n",
    "automations/pulse/automation.md": automationFile("*/5 * * * *", true),
  });
  expect(await refused(configuration(f.root))).toMatch(
    /automations\/pulse\/automation\.md: is not allowed beside a flat definition/,
  );
});

test("an empty automations/ loads no automations beside a directory definition", async () => {
  const f = await repository();
  await put(f.root, base);
  await mkdir(join(f.root, own), { recursive: true });
  expect((await configuration(f.root)).automations).toEqual([]);
});

test("a later provider reset does not postpone the clock past an enabled automation", async () => {
  const time = at(12, 0);
  const { tools, schedules } = watchdogFixture();
  const state: State = {
    enabled: true,
    owner: "T-owner",
    runs: {
      A: {
        kind: "running",
        base: "abc",
        worktree: "/TEST/worktree",
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
        incident: {
          id: "limit",
          ticket: "A",
          owner: "T-owner",
          base: "abc",
          attempt: 1,
          reason: "provider-limit",
          recovery: "wait",
          delivery: "sent",
          providerLimit: {
            thread: "T-worker",
            message: "Private",
            observedAt: time,
            resetAt: at(19, 0),
          },
        },
      },
    },
  };
  const sync = () =>
    reconcileSchedule(
      "/TEST/project",
      "/TEST/git",
      state,
      [{ id: "A", brief: "Private", after: [] }],
      tools,
      () => {},
      true,
      "T-owner",
      time,
    );
  const schedule = () =>
    JSON.stringify(schedules.get("T-owner")?.trigger ?? "");
  await sync();
  expect(state.monitor?.wakeAt).toBe(at(19, 1));
  expect(schedule()).toContain("DTSTART:20261119T190100Z");
  state.automations = {
    pulse: {
      schedule: "*/5 * * * *",
      prompt: "Check.",
      authored: true,
      armedAt: time,
    },
  };
  await sync();
  expect(state.monitor?.schedule).toBe("installed");
  expect(state.monitor?.wakeAt).toBeUndefined();
  expect(schedule()).not.toContain("DTSTART:20261119T190100Z");
  expect(schedule()).toContain("INTERVAL=5");
  // Disabling it returns to the reset-anchored wake.
  state.automations.pulse!.override = false;
  await sync();
  expect(state.monitor?.wakeAt).toBe(at(19, 1));
  expect(schedule()).toContain("DTSTART:20261119T190100Z");
});

test("a failed schedule change that leaves the old provider-reset anchor stays unknown until the real schedule drops it", async () => {
  const time = at(12, 0);
  const fixture = watchdogFixture();
  let failSets = false;
  let sets = 0;
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.set_schedule") {
        sets++;
        if (failSets) throw new Error("set lost before applying");
      }
      return fixture.tools.call(name, input);
    },
  };
  const state: State = {
    enabled: true,
    owner: "T-owner",
    runs: {
      A: {
        kind: "running",
        base: "abc",
        worktree: "/TEST/worktree",
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
        incident: {
          id: "limit",
          ticket: "A",
          owner: "T-owner",
          base: "abc",
          attempt: 1,
          reason: "provider-limit",
          recovery: "wait",
          delivery: "sent",
          providerLimit: {
            thread: "T-worker",
            message: "Private",
            observedAt: time,
            resetAt: at(19, 0),
          },
        },
      },
    },
  };
  const sync = () =>
    reconcileSchedule(
      "/TEST/project",
      "/TEST/git",
      state,
      [{ id: "A", brief: "Private", after: [] }],
      tools,
      () => {},
      true,
      "T-owner",
      time,
    );
  const schedule = () =>
    JSON.stringify(fixture.schedules.get("T-owner")?.trigger ?? "");
  await sync();
  expect(schedule()).toContain("DTSTART:20261119T190100Z");
  // A daily automation keeps the 30-minute period, so only the anchor differs.
  state.automations = {
    daily: {
      schedule: "0 13 * * *",
      prompt: "Check.",
      authored: true,
      armedAt: time,
    },
  };
  failSets = true;
  expect(await sync().catch(String)).toMatch(/not confirmed/);
  expect(state.monitor?.schedule).toBe("unknown");
  expect(state.monitor?.wakeAt).toBe(at(19, 1));
  expect(schedule()).toContain("DTSTART:20261119T190100Z");
  // Another reconcile retries and is only confirmed once the anchor is really gone.
  expect(await sync().catch(String)).toMatch(/not confirmed/);
  failSets = false;
  const before = sets;
  await sync();
  expect(sets).toBe(before + 1);
  expect(state.monitor?.schedule).toBe("installed");
  expect(state.monitor?.wakeAt).toBeUndefined();
  expect(schedule()).not.toContain("DTSTART:20261119T190100Z");
  await sync();
  expect(sets).toBe(before + 1);
});

test("an applied but unconfirmed reset anchor never holds back an enabled automation", async () => {
  const time = at(12, 0);
  const fixture = watchdogFixture();
  let loseReadback = false;
  let sets = 0;
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.get_schedule" && loseReadback && sets > 0) {
        loseReadback = false;
        throw new Error("Lost read-back");
      }
      if (name === "amp.set_schedule") sets++;
      return fixture.tools.call(name, input);
    },
  };
  const state: State = {
    enabled: true,
    owner: "T-owner",
    runs: {
      A: {
        kind: "running",
        base: "abc",
        worktree: "/TEST/worktree",
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
        incident: {
          id: "limit",
          ticket: "A",
          owner: "T-owner",
          base: "abc",
          attempt: 1,
          reason: "provider-limit",
          recovery: "wait",
          delivery: "sent",
          providerLimit: {
            thread: "T-worker",
            message: "Private",
            observedAt: time,
            resetAt: at(19, 0),
          },
        },
      },
    },
  };
  const sync = () =>
    reconcileSchedule(
      "/TEST/project",
      "/TEST/git",
      state,
      [{ id: "A", brief: "Private", after: [] }],
      tools,
      () => {},
      true,
      "T-owner",
      time,
    );
  const schedule = () =>
    JSON.stringify(fixture.schedules.get("T-owner")?.trigger ?? "");
  // The reset anchor lands remotely but its read-back fails, so nothing confirms it.
  loseReadback = true;
  expect(await sync().catch(String)).toMatch(/inspection failed/);
  expect(state.monitor?.schedule).toBe("unknown");
  expect(state.monitor?.wakeAt).toBeUndefined();
  expect(schedule()).toContain("DTSTART:20261119T190100Z");
  // A daily automation keeps the 30-minute period; the unconfirmed anchor must not hold it back.
  state.automations = {
    daily: {
      schedule: "0 13 * * *",
      prompt: "Check.",
      authored: true,
      armedAt: time,
    },
  };
  const before = sets;
  await sync();
  expect(sets).toBe(before + 1);
  expect(state.monitor?.schedule).toBe("installed");
  expect(state.monitor?.wakeAt).toBeUndefined();
  expect(schedule()).not.toContain("DTSTART:20261119T190100Z");
  await sync();
  expect(sets).toBe(before + 1);
});

test("a pending anchor that was never confirmed cannot hide behind the last confirmed one", async () => {
  const time = at(12, 0);
  const fixture = watchdogFixture();
  let sets = 0;
  const tools = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.set_schedule") sets++;
      return fixture.tools.call(name, input);
    },
  };
  const state: State = {
    enabled: true,
    owner: "T-owner",
    runs: {
      A: {
        kind: "running",
        base: "abc",
        worktree: "/TEST/worktree",
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
        incident: {
          id: "limit",
          ticket: "A",
          owner: "T-owner",
          base: "abc",
          attempt: 1,
          reason: "provider-limit",
          recovery: "wait",
          delivery: "sent",
          providerLimit: {
            thread: "T-worker",
            message: "Private",
            observedAt: time,
            resetAt: at(19, 0),
          },
        },
      },
    },
  };
  const sync = () =>
    reconcileSchedule(
      "/TEST/project",
      "/TEST/git",
      state,
      [{ id: "A", brief: "Private", after: [] }],
      tools,
      () => {},
      true,
      "T-owner",
      time,
    );
  const schedule = () =>
    JSON.stringify(fixture.schedules.get("T-owner")?.trigger ?? "");
  await sync();
  expect(state.monitor?.wakeAt).toBe(at(19, 1));
  expect(schedule()).toContain("DTSTART:20261119T190100Z");
  // A retime to a later reset landed remotely but was never confirmed: the monitor still records
  // 19:01 while the registration wakes at 20:01 (read back in normalized TZID form, 15:01 EST).
  fixture.schedules.get("T-owner")!.trigger = {
    provider: "schedule",
    schedule:
      "DTSTART;TZID=America/New_York:20261119T150100\r\nRRULE:FREQ=MINUTELY;INTERVAL=30",
  };
  state.automations = {
    daily: {
      schedule: "0 13 * * *",
      prompt: "Check.",
      authored: true,
      armedAt: time,
    },
  };
  const before = sets;
  await sync();
  expect(sets).toBe(before + 1);
  expect(state.monitor?.schedule).toBe("installed");
  expect(state.monitor?.wakeAt).toBeUndefined();
  expect(schedule()).not.toContain("20261119T150100");
  await sync();
  expect(sets).toBe(before + 1);
});

test("accepting a definition and its automations is one write: a failure leaves the old digest with the old automations, on reload and on first start", async () => {
  const f = await engine({
    pulse: automationFile("*/5 * * * *", true, "Old."),
  });
  await f.tick("start");
  const before = factoryStatus(f.factory.directory);
  const oldDigest = factoryDefinition(f.factory.directory)!.digest;
  const database = () =>
    new Database(join(f.factory.directory, "state.sqlite"));
  const db = database();
  db.run(
    "CREATE TRIGGER interrupt BEFORE UPDATE ON automations BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
  );
  db.run(
    "CREATE TRIGGER interrupt_insert BEFORE INSERT ON automations BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
  );
  db.close();
  await put(f.root, {
    "automations/pulse/automation.md": automationFile(
      "*/5 * * * *",
      true,
      "New.",
    ),
  });
  expect(await refused(f.tick("reload"))).toMatch(/interrupted/);
  expect(factoryDefinition(f.factory.directory)!.digest).toBe(oldDigest);
  expect(factoryStatus(f.factory.directory).automations).toEqual(
    before.automations,
  );
  // With the interruption gone the whole new snapshot lands together.
  const cleared = database();
  cleared.run("DROP TRIGGER interrupt");
  cleared.run("DROP TRIGGER interrupt_insert");
  cleared.close();
  await f.tick("reload");
  expect(factoryDefinition(f.factory.directory)!.digest).not.toBe(oldDigest);
  expect(factoryStatus(f.factory.directory).automations?.pulse?.prompt).toBe(
    "New.",
  );

  // First start: no definition is accepted when its automations cannot be written.
  const g = await repository();
  await put(g.root, {
    ...base,
    "automations/pulse/automation.md": automationFile("*/5 * * * *", true),
  });
  g.git("add", ".");
  g.git("commit", "-qm", "fixture");
  const host: NativeHost = {
    async create() {
      return "T-worker";
    },
    async send() {},
    async state() {
      return "running";
    },
    watch() {},
  };
  const factory = createFactory(g.root, host, openStore);
  openPersistence(factory.directory, []).close();
  const raw = new Database(join(factory.directory, "state.sqlite"));
  raw.run(
    "CREATE TABLE automations (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
  );
  raw.run(
    "CREATE TRIGGER interrupt BEFORE INSERT ON automations BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
  );
  raw.close();
  const { tools } = watchdogFixture();
  expect(
    await refused(
      factory.tick("start", "T-owner", host.state, undefined, tools),
    ),
  ).toMatch(/interrupted/);
  expect(factoryDefinition(factory.directory)).toBeUndefined();
  expect(factoryStatus(factory.directory).automations).toBeUndefined();
});

test("a first start with only planned tickets and an enabled automation refuses without a usable clock", async () => {
  const unrelated = { title: "Someone else", prompt: "Mine" };
  for (const failure of ["unrelated schedule", "unconfirmed set"]) {
    const f = await engine({ pulse: automationFile("*/5 * * * *", true) });
    const { tools, schedules } = f.fixture;
    if (failure === "unrelated schedule")
      schedules.set("T-owner", {
        ...unrelated,
        targetThreadID: "T-owner",
        trigger: { schedule: "RRULE:FREQ=DAILY" },
        runMode: "existing",
        enabled: true,
      });
    const broken = {
      async call(name: string, input: Record<string, unknown>) {
        if (failure === "unconfirmed set" && name === "amp.set_schedule")
          throw new Error("set lost before applying");
        return tools.call(name, input);
      },
    };
    expect(
      await refused(
        f.factory.tick("start", "T-owner", f.host.state, undefined, broken),
      ),
    ).toMatch(
      failure === "unrelated schedule" ? /unrelated schedule/ : /not confirmed/,
    );
    const state = factoryStatus(f.factory.directory);
    expect(state.enabled).toBe(false);
    expect(state.owner).toBeUndefined();
    expect(state.automations).toBeUndefined();
    expect(factoryDefinition(f.factory.directory)).toBeUndefined();
    expect(f.created()).toBe(0);
    if (failure === "unrelated schedule")
      expect(schedules.get("T-owner")).toMatchObject(unrelated);
    else expect(schedules.size).toBe(0);
  }
});

test("cron lookups follow the calendar", () => {
  // Thursday 2026-11-19 12:07.
  const now = at(12, 7);
  expect(lastFire("*/5 * * * *", now)).toBe(at(12, 5));
  expect(lastFire("7 12 * * *", now)).toBe(now);
  expect(lastFire("0 3 * * *", at(2, 0))).toBe(at(3, 0, 18));
  // Monday 2026-11-16, three days back.
  expect(lastFire("30 9 * * 1", now)).toBe(Date.UTC(2026, 10, 16, 9, 30));
  expect(lastFire("30 9 * * 7", now)).toBe(Date.UTC(2026, 10, 15, 9, 30));
  // Either day field may match when both are restricted.
  expect(lastFire("0 0 17 * 4", now)).toBe(at(0, 0));
  expect(lastFire("0 0 29 2 *", now)).toBe(Date.UTC(2024, 1, 29));
  expect(lastFire("0 0 * * *", at(0, 0))).toBe(at(0, 0));

  expect(validCron("0 0 29 2 *")).toBe(true);
  expect(validCron("1-10/3,50 */6 * * 1-5")).toBe(true);
  for (const bad of [
    "",
    "* * * *",
    "5/10 * * * *",
    "1-3-5 * * * *",
    "3-1 * * * *",
  ])
    expect(validCron(bad)).toBe(false);
  expect(shortestGapMinutes("*/5 * * * *")).toBe(5);
  expect(shortestGapMinutes("0,7 * * * *")).toBe(7);
  expect(shortestGapMinutes("0 * * * *")).toBe(60);
  expect(shortestGapMinutes("0 3 * * *")).toBe(1440);
});

// A started factory on the fixture repository whose clock the test moves.
async function engine(
  automations: Record<string, string>,
  tickets: object[] = planned,
) {
  const f = await repository(tickets);
  await put(f.root, {
    ...base,
    ...Object.fromEntries(
      Object.entries(automations).map(([name, text]) => [
        `automations/${name}/automation.md`,
        text,
      ]),
    ),
  });
  f.git("add", ".");
  f.git("commit", "-qm", "fixture");
  let clock = at(12, 0);
  const messages: { thread: string; message: string }[] = [];
  let created = 0;
  const outcome = { failOwnerSends: false };
  const host: NativeHost = {
    async create() {
      created++;
      return "T-worker";
    },
    async send(thread, message) {
      messages.push({ thread, message });
      if (thread === "T-owner" && outcome.failOwnerSends)
        throw new Error("lost send response");
    },
    async state() {
      return "running";
    },
    watch() {},
  };
  const factory = createFactory(f.root, host, openStore, () => clock);
  const fixture = watchdogFixture();
  const tick = (
    action: "start" | "reconcile" | "reload" | "pause",
    owner: `T-${string}` = "T-owner",
    tools: typeof fixture.tools | null = fixture.tools,
  ) => factory.tick(action, owner, host.state, undefined, tools ?? undefined);
  const wake = (time: number) => {
    clock = time;
    return tick("reconcile");
  };
  const sent = () =>
    messages.filter(
      (m) =>
        m.thread === "T-owner" && m.message.startsWith("Factory automation"),
    );
  const control = (
    action: Parameters<typeof factory.automation>[0],
    name?: string,
    owner: `T-${string}` = "T-owner",
    tools: typeof fixture.tools | null = fixture.tools,
  ) => factory.automation(action, name, owner, tools ?? undefined);
  const interval = (thread = "T-owner") => {
    const trigger = fixture.schedules.get(thread)?.trigger as
      { schedule: string } | undefined;
    return trigger && /INTERVAL=(\d+)/.exec(trigger.schedule)?.[1];
  };
  return {
    ...f,
    host,
    factory,
    fixture,
    outcome,
    tick,
    wake,
    sent,
    control,
    interval,
    messages,
    created: () => created,
    at: (time: number) => (clock = time),
  };
}

test("dashboard requests apply oldest first only on connected owner reconciliation, once, including expiry", async () => {
  const f = await engine({
    pulse: automationFile("*/5 * * * *", false, "Requested run."),
  });
  await f.tick("start");
  await f.tick("pause");
  const directory = f.factory.directory;
  enqueueAutomationRequest(directory, "pulse", "run", at(10, 0));
  enqueueAutomationRequest(directory, "pulse", "enable", at(11, 0));
  enqueueAutomationRequest(directory, "pulse", "run", at(12, 0));
  enqueueAutomationRequest(directory, "pulse", "disable", at(12, 0));
  await f.factory.tick("status");
  await f.tick("reconcile", "T-owner", null).catch(() => {});
  expect(factoryRecords(directory)!.requests.map((row) => row.status)).toEqual([
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  expect(f.sent()).toEqual([]);
  await f.tick("reconcile");
  const records = factoryRecords(directory)!;
  expect(
    records.requests.map(({ action, status, reason }) => ({
      action,
      status,
      reason,
    })),
  ).toEqual([
    {
      action: "run",
      status: "refused",
      reason: "Request expired after one hour.",
    },
    { action: "enable", status: "applied", reason: null },
    { action: "run", status: "applied", reason: null },
    { action: "disable", status: "applied", reason: null },
  ]);
  expect(f.sent()).toEqual([
    { thread: "T-owner", message: "Factory automation pulse\nRequested run." },
  ]);
  expect(records.state.enabled).toBe(false);
  expect(records.state.runs).toEqual({});
  expect(records.state.automations!.pulse!.override).toBe(false);
  expect(records.state.automations!.pulse!.lastRunAt).toBe(at(12, 0));
  const before = factoryEvents(directory);
  await f.tick("reconcile");
  expect(f.sent()).toHaveLength(1);
  expect(factoryEvents(directory)).toEqual(before);
});

test("a removed automation refuses its queued request without blocking the next request or reconcile", async () => {
  const f = await engine({
    removed: automationFile("*/5 * * * *", false),
    pulse: automationFile("*/5 * * * *", false, "Still loaded."),
  });
  await f.tick("start");
  await f.tick("pause");
  enqueueAutomationRequest(f.factory.directory, "removed", "run", at(12, 0));
  enqueueAutomationRequest(f.factory.directory, "pulse", "run", at(12, 0));
  await rm(join(f.root, "factory/config/automations/removed"), {
    recursive: true,
  });
  f.git("add", ".");
  f.git("commit", "-qm", "remove automation");
  await f.tick("reload");
  await f.tick("reconcile");
  expect(factoryRecords(f.factory.directory)!.requests).toMatchObject([
    {
      name: "removed",
      status: "refused",
      reason: "Error: Unknown automation removed",
    },
    { name: "pulse", status: "applied", reason: null },
  ]);
  expect(f.sent()).toEqual([
    { thread: "T-owner", message: "Factory automation pulse\nStill loaded." },
  ]);
  await f.tick("reconcile");
  expect(f.sent()).toHaveLength(1);
});

test("a dashboard run with a lost send reply is visibly refused and never retried after restart", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", false) });
  await f.tick("start");
  await f.tick("pause");
  f.outcome.failOwnerSends = true;
  enqueueAutomationRequest(f.factory.directory, "pulse", "run", at(12, 0));
  await f.tick("reconcile");
  const request = factoryRecords(f.factory.directory)!.requests[0]!;
  expect(request.status).toBe("refused");
  expect(request.reason).toContain("outcome unknown");
  expect(f.sent()).toHaveLength(1);
  const restarted = createFactory(f.root, f.host, openStore, () => at(12, 0));
  await restarted.tick(
    "reconcile",
    "T-owner",
    f.host.state,
    undefined,
    f.fixture.tools,
  );
  expect(f.sent()).toHaveLength(1);
  expect(
    factoryStatus(f.factory.directory).automations!.pulse!.lastOutcome,
  ).toBe("unknown");
});

test("missed wakes collapse into one run: wakes at 0, 5 and 25 minutes send three times, not six", async () => {
  const f = await engine({
    pulse: automationFile("*/5 * * * *", true, "Pulse it."),
  });
  await f.tick("start");
  expect(f.interval()).toBe("5");
  expect(f.sent()).toEqual([]);
  for (const [minute, total] of [
    [0, 1],
    [5, 2],
    [25, 3],
    [25, 3],
    [27, 3],
    [30, 4],
  ] as const) {
    await f.wake(at(12, minute));
    expect(f.sent()).toHaveLength(total);
  }
  expect(f.sent()[0]).toEqual({
    thread: "T-owner",
    message: "Factory automation pulse\nPulse it.",
  });
  expect(factoryStatus(f.factory.directory).automations?.pulse).toMatchObject({
    lastRunAt: at(12, 30),
    lastOutcome: "sent",
  });
});

test("a disabled automation never fires on the clock, and automation-run sends it once", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", false) });
  await f.tick("start");
  // No enabled automation and no work: the factory holds no schedule.
  expect(f.fixture.schedules.size).toBe(0);
  for (const minute of [0, 5, 10, 25]) await f.wake(at(12, minute));
  expect(f.sent()).toEqual([]);

  const rows = await f.control("automation-run", "pulse");
  expect(f.sent().map((m) => m.message)).toEqual([
    "Factory automation pulse\nCheck.",
  ]);
  expect(rows).toEqual([
    {
      name: "pulse",
      schedule: "*/5 * * * *",
      enabled: false,
      lastRunAt: at(12, 25),
      lastOutcome: "sent",
    },
  ]);
  // Still disabled: later wakes send nothing and the schedule stays absent.
  await f.wake(at(12, 40));
  expect(f.sent()).toHaveLength(1);
  expect(f.fixture.schedules.size).toBe(0);
});

test("a send with an unknown outcome is recorded and not retried on the next wake", async () => {
  const f = await engine({ daily: automationFile("0 12 * * *", true) });
  await f.tick("start");
  f.outcome.failOwnerSends = true;
  await f.wake(at(12, 0));
  expect(f.sent()).toHaveLength(1);
  expect(factoryStatus(f.factory.directory).automations?.daily).toMatchObject({
    lastRunAt: at(12, 0),
    lastOutcome: "unknown",
  });
  f.outcome.failOwnerSends = false;
  for (const [hour, minute] of [
    [12, 0],
    [12, 30],
    [23, 30],
  ] as const)
    await f.wake(at(hour, minute));
  expect(f.sent()).toHaveLength(1);
  // The next scheduled time is a new run.
  await f.wake(at(12, 0, 20));
  expect(f.sent()).toHaveLength(2);
  expect(
    factoryStatus(f.factory.directory).automations?.daily?.lastOutcome,
  ).toBe("sent");
});

test("automation-run with an unknown outcome is recorded, reported and not retried", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", false) });
  await f.tick("start");
  f.outcome.failOwnerSends = true;
  expect(await refused(f.control("automation-run", "pulse"))).toMatch(
    /outcome unknown; it is recorded and not retried/,
  );
  expect(f.sent()).toHaveLength(1);
  expect(
    factoryStatus(f.factory.directory).automations?.pulse?.lastOutcome,
  ).toBe("unknown");
});

test("a paused factory and a wake with no caller send nothing", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", true) });
  await f.tick("start");
  // Plugin-load recovery reconciles with no thread.
  f.at(at(12, 5));
  await f.factory.tick("reconcile", undefined, f.host.state);
  expect(f.sent()).toEqual([]);
  f.at(at(12, 6));
  await f.tick("pause");
  await f.wake(at(12, 10));
  expect(f.sent()).toEqual([]);
  // Resuming the clock sends the one missed run.
  await f.tick("start");
  await f.wake(at(12, 11));
  expect(f.sent()).toHaveLength(1);
});

test("the observer's wake sends to the owner thread", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", true) });
  await f.tick("start");
  f.host.create = async () => "T-observer";
  await f.factory.observer("register-observer", "T-owner", f.fixture.tools);
  f.at(at(12, 5));
  await f.tick("reconcile", "T-observer", null);
  expect(f.sent()).toHaveLength(1);
  expect(f.sent()[0]!.thread).toBe("T-owner");
});

test("a file added or edited without reload changes nothing the clock sends, until reload", async () => {
  const f = await engine({
    pulse: automationFile("*/5 * * * *", true, "Old."),
  });
  await f.tick("start");
  await put(f.root, {
    "automations/pulse/automation.md": automationFile(
      "0 0 1 1 *",
      true,
      "New.",
    ),
    "automations/extra/automation.md": automationFile(
      "*/5 * * * *",
      true,
      "Extra.",
    ),
  });
  expect((await configuration(f.root)).automations).toHaveLength(2);
  expect((await effectiveConfiguration(f.root)).digest).not.toBe(
    (await configuration(f.root)).digest,
  );
  await f.wake(at(12, 5));
  expect(f.sent().map((m) => m.message)).toEqual([
    "Factory automation pulse\nOld.",
  ]);
  expect(Object.keys(factoryStatus(f.factory.directory).automations!)).toEqual([
    "pulse",
  ]);

  await f.tick("reload");
  expect(
    (await f.control("automations")).map((row) => [row.name, row.enabled]),
  ).toEqual([
    ["extra", true],
    ["pulse", true],
  ]);
  await f.wake(at(12, 10));
  expect(f.sent().map((m) => m.message)).toEqual([
    "Factory automation pulse\nOld.",
    "Factory automation extra\nExtra.",
  ]);
  // The edited pulse schedule is yearly now; the last run stays recorded.
  expect(factoryStatus(f.factory.directory).automations?.pulse?.lastRunAt).toBe(
    at(12, 5),
  );
});

test("an invalid automation file added without reload refuses reconcile and sends nothing", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", true) });
  await f.tick("start");
  await put(f.root, { "automations/bad/automation.md": "Check.\n" });
  expect(await refused(f.wake(at(12, 5)))).toMatch(
    /automations\/bad\/automation\.md: schedule is required/,
  );
  expect(f.sent()).toEqual([]);
});

test("the control override wins until a reload changes the authored value", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", true) });
  await f.tick("start");
  await f.control("automation-disable", "pulse");
  await f.wake(at(12, 5));
  expect(f.sent()).toEqual([]);
  // Reload with the authored value unchanged keeps the override.
  await f.tick("reload");
  expect((await f.control("automations"))[0]!.enabled).toBe(false);
  // An edited authored value drops it.
  await put(f.root, {
    "automations/pulse/automation.md": automationFile("*/5 * * * *", false),
  });
  await f.tick("reload");
  await f.control("automation-enable", "pulse");
  await put(f.root, {
    "automations/pulse/automation.md": automationFile("*/5 * * * *", true),
  });
  await f.tick("reload");
  expect((await f.control("automations"))[0]!.enabled).toBe(true);
  await f.control("automation-disable", "pulse");
  await put(f.root, {
    "automations/pulse/automation.md": automationFile("*/5 * * * *", false),
  });
  await f.tick("reload");
  expect((await f.control("automations"))[0]!.enabled).toBe(false);
});

test("one schedule uses the shortest active interval and preserves unrelated registrations", async () => {
  const f = await engine(
    { pulse: automationFile("*/5 * * * *", false) },
    admitted,
  );
  await f.tick("start");
  expect(f.interval()).toBe("1");
  await f.control("automation-enable", "pulse");
  expect(f.interval()).toBe("1");
  f.host.state = async () => "error";
  await f.tick("reconcile");
  expect(f.interval()).toBe("5");
  expect(f.fixture.schedules.size).toBe(1);
  // A repeat changes nothing and writes no event.
  const events = JSON.stringify(factoryEvents(f.factory.directory, 0, 500));
  await f.control("automation-enable", "pulse");
  expect(JSON.stringify(factoryEvents(f.factory.directory, 0, 500))).toBe(
    events,
  );
  await f.control("automation-disable", "pulse");
  expect(f.interval()).toBe("30");

  // An unrelated schedule on the thread is preserved, and the override still lands.
  const ours = f.fixture.schedules.get("T-owner")!;
  f.fixture.schedules.set("T-owner", {
    ...ours,
    title: "Someone else",
    prompt: "Mine",
  });
  await f.control("automation-enable", "pulse");
  expect(f.fixture.schedules.get("T-owner")).toMatchObject({
    title: "Someone else",
  });
  const state = factoryStatus(f.factory.directory);
  expect(state.monitor).toMatchObject({ schedule: "conflict" });
  expect(state.monitor?.problem).toMatch(/unrelated schedule/);
  expect(state.automations?.pulse?.override).toBe(true);
});

test("disabling the last automation with no work clears the schedule", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", true) });
  await f.tick("start");
  expect(f.interval()).toBe("5");
  await f.control("automation-disable", "pulse");
  expect(f.fixture.schedules.size).toBe(0);
});

test("an unconfirmed schedule change is recorded as unknown like any other watchdog effect", async () => {
  const f = await engine(
    { pulse: automationFile("*/5 * * * *", false) },
    admitted,
  );
  await f.tick("start");
  const broken = {
    async call(name: string, input: Record<string, unknown>) {
      if (name === "amp.get_schedule")
        throw new Error("Disconnected inspection");
      return f.fixture.tools.call(name, input);
    },
  };
  await f.control("automation-enable", "pulse", "T-owner", broken);
  expect(factoryStatus(f.factory.directory).monitor?.schedule).toBe("unknown");
  expect(factoryStatus(f.factory.directory).automations?.pulse?.override).toBe(
    true,
  );
});

test("enable and disable without connected owner tools change nothing", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", false) });
  await f.tick("start");
  const before = JSON.stringify(factoryStatus(f.factory.directory));
  for (const action of ["automation-enable", "automation-disable"] as const)
    expect(await refused(f.control(action, "pulse", "T-owner", null))).toMatch(
      /connected owner tools/,
    );
  expect(JSON.stringify(factoryStatus(f.factory.directory))).toBe(before);
  expect(await refused(f.control("automation-run", "missing"))).toMatch(
    /Unknown automation missing/,
  );
  expect(await refused(f.control("automation-enable", "toString"))).toMatch(
    /Unknown automation toString/,
  );
});

test("a non-owner, a worker and the observer are refused every automation action, leaving state unchanged", async () => {
  const f = await engine(
    { pulse: automationFile("*/5 * * * *", true) },
    admitted,
  );
  await f.tick("start");
  f.host.create = async () => "T-observer";
  await f.factory.observer("register-observer", "T-owner", f.fixture.tools);
  const snapshot = () =>
    JSON.stringify([
      factoryStatus(f.factory.directory),
      factoryEvents(f.factory.directory, 0, 500),
    ]);
  const before = snapshot();
  const sends = f.sent().length;
  const callers: [`T-${string}`, RegExp][] = [
    ["T-stranger", /Control requires the owning Foreman/],
    ["T-worker", /Workers cannot control the factory/],
    ["T-observer", /observer may only reconcile/],
  ];
  for (const [caller, message] of callers)
    for (const action of [
      "automations",
      "automation-enable",
      "automation-disable",
      "automation-run",
    ] as const)
      expect(await refused(f.control(action, "pulse", caller))).toMatch(
        message,
      );
  expect(snapshot()).toBe(before);
  expect(f.sent()).toHaveLength(sends);
});

test("no automation admits, starts, resumes or dispatches work", async () => {
  const f = await engine({ pulse: automationFile("*/5 * * * *", true) }, [
    ...admitted,
    {
      id: "B",
      brief: "Later",
      after: ["A"],
      intake: "planned",
      outcome: "Planned later",
    },
  ]);
  await f.tick("start");
  const runs = JSON.stringify(factoryStatus(f.factory.directory).runs);
  const created = f.created();
  const others = () =>
    f.messages.filter((m) => !m.message.startsWith("Factory automation"));
  const before = others().length;
  for (const minute of [0, 5, 25]) await f.wake(at(12, minute));
  await f.control("automation-run", "pulse");
  await f.control("automation-disable", "pulse");
  await f.control("automation-enable", "pulse");
  expect(f.sent()).toHaveLength(4);
  expect(JSON.stringify(factoryStatus(f.factory.directory).runs)).toBe(runs);
  expect(Object.keys(factoryStatus(f.factory.directory).runs)).toEqual(["A"]);
  expect(f.created()).toBe(created);
  expect(others()).toHaveLength(before);
});
