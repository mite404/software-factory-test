import { expect, test } from "bun:test";
import type { PluginTools } from "@ampcode/plugin";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchdogFixture } from "./bookkeeping.fixture";
import {
  factoryEvents,
  factoryStatus,
  openPersistence,
  type State,
} from "./persistence";
import { deliverAlerts, reconcileSchedule } from "./watchdog";

test("planning metadata cannot drop monitoring for an existing active run", async () => {
  const state: State = { enabled: true, owner: "T-owner", runs: {} };
  const { tools } = watchdogFixture();
  const sync = () =>
    reconcileSchedule(
      "/TEST/project",
      "/TEST/git",
      state,
      [
        {
          id: "A",
          brief: "PRIVATE",
          after: [],
          intake: "planned",
          outcome: "Public plan",
        },
      ],
      tools,
      () => {},
    );
  await sync();
  expect(state.monitor?.schedule).toBe("cleared");
  state.runs.A = {
    kind: "running",
    base: "abc",
    worktree: "/TEST/worktree",
    thread: "T-worker",
    attempt: 1,
    delivery: "sent",
  };
  await sync();
  expect(state.monitor?.schedule).toBe("installed");
  state.runs.A = {
    kind: "done",
    thread: "T-worker",
    revision: "def",
    insight: "Verified",
  };
  await sync();
  expect(state.monitor?.schedule).toBe("cleared");
});

test("owned schedule converges after lost create/clear acknowledgments and preserves conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-schedule-"));
  const storage = openPersistence(directory, []);
  const state: State = { enabled: true, owner: "T-owner", runs: {} };
  let actual: Record<string, unknown> | null = null;
  let creates = 0;
  let clears = 0;
  let readsUnavailable = false;
  let loseInspection = false;
  const fixture = watchdogFixture();
  const tools: PluginTools = {
    async call(name, input) {
      if (name === "amp.get_schedule") {
        if (readsUnavailable) throw new Error("Disconnected inspection");
        return JSON.stringify(actual);
      }
      if (name === "amp.set_schedule") {
        creates++;
        actual = (await fixture.tools.call(name, input)) as Record<
          string,
          unknown
        >;
        if (loseInspection) readsUnavailable = true;
        throw new Error("Lost create acknowledgment");
      }
      if (name === "amp.clear_schedule") {
        clears++;
        actual = null;
        if (loseInspection) readsUnavailable = true;
        throw new Error("Lost clear acknowledgment");
      }
      throw new Error(`Unexpected ${name}`);
    },
  };
  const save = () => storage.commit(state, "factory", "fixture", "");
  const sync = (root = "/TEST/factory") =>
    reconcileSchedule(
      root,
      directory,
      state,
      [{ id: "A", brief: "PRIVATE", after: [] }],
      tools,
      save,
    );
  try {
    await sync();
    expect(actual).toMatchObject({
      trigger: {
        schedule: "DTSTART:20261114T143900Z\nRRULE:FREQ=MINUTELY;INTERVAL=30",
      },
      runMode: "existing",
      enabled: true,
    });
    expect(JSON.stringify(actual)).not.toContain("PRIVATE");
    expect(factoryStatus(directory).monitor?.schedule).toBe("installed");
    await sync();
    expect(creates).toBe(1);
    expect(await sync("/TEST/second-root").catch(String)).toMatch(
      /fingerprint/,
    );
    expect(factoryStatus(directory).monitor?.schedule).toBe("conflict");
    const other: State = { enabled: true, owner: "T-owner", runs: {} };
    expect(
      await reconcileSchedule(
        "/TEST/second-root",
        directory,
        other,
        [{ id: "B", brief: "PRIVATE", after: [] }],
        tools,
        () => {},
      ).catch(String),
    ).toMatch(/second factory root/);
    expect(other.monitor?.schedule).toBe("conflict");
    expect(creates).toBe(1);
    actual = null;
    loseInspection = true;
    expect(await sync().catch(String)).toMatch(/inspection/);
    expect(creates).toBe(2);
    expect(await sync().catch(String)).toMatch(/inspection/);
    expect(factoryStatus(directory).monitor?.schedule).toBe("unknown");
    expect(creates).toBe(2);
    readsUnavailable = false;
    await sync();
    expect(creates).toBe(2);
    state.enabled = false;
    expect(await sync().catch(String)).toMatch(/inspection/);
    expect(factoryStatus(directory).monitor?.schedule).toBe("unknown");
    readsUnavailable = false;
    await sync();
    expect(actual).toBeNull();
    expect(clears).toBe(1);
    expect(factoryStatus(directory).monitor?.schedule).toBe("cleared");
    actual = { title: "Unrelated reminder", prompt: "Keep me" };
    await sync();
    expect(actual).toEqual({ title: "Unrelated reminder", prompt: "Keep me" });
    expect(clears).toBe(1);
    expect(factoryStatus(directory).monitor?.schedule).toBe("cleared");
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["absent", "unreadable", "uncleared"])(
  "handoff cleanup converges without unchanged writes for %s",
  async (fault) => {
    const directory = await mkdtemp(join(tmpdir(), "factory-cleanup-"));
    const storage = openPersistence(directory, []);
    const state: State = { enabled: true, owner: "T-old", runs: {} };
    const old = watchdogFixture("T-old");
    const next = watchdogFixture("T-new", old.schedules);
    let blocked = true;
    const tools: PluginTools = {
      async call(name, input) {
        if (blocked && input.thread === "T-old") {
          if (fault === "unreadable") throw new Error("Old thread unavailable");
          if (fault === "uncleared" && name === "amp.clear_schedule")
            return { deleted: true };
        }
        return next.tools.call(name, input);
      },
    };
    const sync = (connected: PluginTools) =>
      reconcileSchedule(
        "/TEST/factory",
        directory,
        state,
        [{ id: "A", brief: "PRIVATE", after: [] }],
        connected,
        () => storage.commit(state, "factory", "fixture-cleanup", ""),
      );
    try {
      await sync(old.tools);
      state.owner = "T-new";
      state.foreman = {
        notes: [],
        handoffs: [
          {
            at: 1,
            from: "T-old",
            to: "T-new",
            decision: "Take over",
            clear: "pending",
          },
        ],
      };
      if (fault === "absent") old.schedules.delete("T-old");
      await sync(tools);
      expect(state.monitor?.schedule).toBe("installed");
      expect(state.foreman.handoffs[0]?.clear).toBe(
        fault === "absent" ? "cleared" : "unreachable",
      );
      if (fault === "unreadable") {
        // Legacy unreachable handoffs can lack an alert reservation.
        state.monitor!.notifications = [];
        storage.commit(state, "factory", "fixture-legacy-alert", "");
      }
      const events = factoryEvents(directory);
      const bytes = await readFile(join(directory, "state.sqlite"));
      await sync(tools);
      expect(factoryEvents(directory)).toEqual(events);
      expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
      expect(next.notifications).toHaveLength(fault === "absent" ? 0 : 1);
      blocked = false;
      await sync(tools);
      expect(state.foreman.handoffs[0]?.clear).toBe("cleared");
      expect(state.foreman.handoffs[0]?.problem).toBeUndefined();
      expect([...old.schedules.keys()]).toEqual(["T-new"]);
      const settled = factoryEvents(directory);
      await sync(tools);
      expect(factoryEvents(directory)).toEqual(settled);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  { patch: { prompt: "Updated wording" }, healthy: true },
  {
    patch: {
      trigger: {
        schedule: "DTSTART:20261114T143900Z\r\nRRULE:INTERVAL=30;FREQ=MINUTELY",
      },
    },
    healthy: true,
  },
  {
    patch: { trigger: { schedule: "RRULE:FREQ=MINUTELY;INTERVAL=31" } },
    healthy: false,
  },
  { patch: { runMode: "fresh" }, healthy: false },
  { patch: { enabled: false }, healthy: false },
])(
  "fingerprint retains ownership across normalization and drift: %j",
  async ({ patch, healthy }) => {
    const state: State = { enabled: true, owner: "T-owner", runs: {} };
    const fixture = watchdogFixture();
    let drift = false;
    const effects: string[] = [];
    const tools: PluginTools = {
      async call(name, input) {
        const result = await fixture.tools.call(name, input);
        if (name === "amp.get_schedule")
          return drift && result
            ? {
                ...(result as object),
                title: state.monitor!.fingerprint,
                ...patch,
              }
            : result;
        effects.push(name);
        return result;
      },
    };
    const sync = () =>
      reconcileSchedule(
        "/TEST/arbitrary-project",
        "/TEST/git",
        state,
        [{ id: "A", brief: "PRIVATE", after: [] }],
        tools,
        () => {},
      );
    await sync();
    const installed = (await fixture.tools.call("amp.get_schedule", {})) as {
      prompt: string;
    };
    expect(installed.prompt).toContain("Never blindly resume");
    expect(installed.prompt).not.toContain(
      "/TEST/arbitrary-project/factory/foreman.md",
    );
    drift = true;
    if (healthy) {
      await sync();
      expect(state.monitor?.schedule).toBe("installed");
    } else {
      expect(await sync().catch(String)).toMatch(/drifted/);
      expect(state.monitor?.schedule).toBe("unknown");
    }
    state.enabled = false;
    await sync();
    expect(state.monitor?.schedule).toBe("cleared");
    expect(await fixture.tools.call("amp.get_schedule", {})).toBeNull();
    expect(effects).toEqual(["amp.set_schedule", "amp.clear_schedule"]);
  },
);

test.each([false, true])(
  "provider anchor converges after failed set or TZID normalization (%s)",
  async (normalize) => {
    const at = Date.parse("2026-11-14T17:19:00Z");
    const state: State = { enabled: true, owner: "T-owner", runs: {} };
    const fixture = watchdogFixture();
    let fail = false;
    let sets = 0;
    const tools: PluginTools = {
      async call(name, input) {
        if (name === "amp.set_schedule") {
          sets++;
          if (fail) {
            fail = false;
            throw new Error("Transient set failure before effect");
          }
        }
        const result = await fixture.tools.call(name, input);
        if (normalize && result && name === "amp.get_schedule") {
          const value = structuredClone(result) as {
            trigger: { schedule: string };
          };
          value.trigger.schedule = value.trigger.schedule
            .replace(
              "DTSTART:20261114T190100Z",
              "DTSTART;TZID=America/New_York:20261114T140100",
            )
            .replaceAll("\n", "\r\n");
          return value;
        }
        return result;
      },
    };
    const sync = (time = at) =>
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
    await sync();
    state.runs.A = {
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
          observedAt: at,
          resetAt: Date.parse("2026-11-14T19:00:00Z"),
        },
      },
    };
    if (!normalize) {
      fail = true;
      expect(await sync().catch(String)).toMatch(/not confirmed/);
    }
    await sync();
    expect(state.monitor?.schedule).toBe("installed");
    expect(state.monitor?.wakeAt).toBe(Date.parse("2026-11-14T19:01:00Z"));
    const count = sets;
    await sync();
    expect(sets).toBe(count);
    await sync(Date.parse("2026-11-14T19:11:00Z"));
    expect(state.monitor?.schedule).toBe("installed");
    expect(state.monitor?.wakeAt).toBeUndefined();
    expect(await fixture.tools.call("amp.get_schedule", {})).toMatchObject({
      trigger: {
        schedule: "DTSTART:20261114T143900Z\nRRULE:FREQ=MINUTELY;INTERVAL=30",
      },
    });
  },
);

test("alert reservations survive reopen, bound a rolling hour and never retry unknown sends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-alerts-"));
  let at = 1000;
  let storage = openPersistence(directory, [], () => at);
  const state = storage.state;
  state.enabled = true;
  state.owner = "T-owner";
  state.monitor = {
    fingerprint: "TEST",
    schedule: "installed",
    notifications: [],
  };
  state.runs.A = {
    kind: "blocked",
    reason: "PRIVATE",
    thread: "T-worker",
    watchdog: {
      episode: "incident-1",
      progressAt: 0,
      attempt: 6,
      alerts: Array.from({ length: 12 }, (_, id) => ({
        id: `alert-${id}`,
        kind: id === 1 ? "spending" : "unresolved",
        episode: "incident-1",
        attempt: 6,
        intendedAt: 0,
      })),
    },
  };
  const fixture = watchdogFixture();
  const sent = fixture.notifications;
  const tools: PluginTools = {
    async call(name, input) {
      expect(name).toBe("amp.notify_user");
      await fixture.tools.call(name, input);
      expect(factoryStatus(directory).monitor?.notifications.at(-1)).toEqual({
        id: `alert-${sent.length - 1}`,
        at,
        outcome: "sending",
      });
      if (sent.length === 1) throw new Error("Lost acknowledgment");
      return {};
    },
  };
  const save = () => storage.commit(state, "factory", "fixture", "");
  try {
    await deliverAlerts(state, tools, () => at, save);
    expect(sent).toHaveLength(10);
    expect(sent[1]).toMatchObject({
      body: "Ticket A, attempt 6. Repeated repair spending. Incident incident-1. Read factory status and private evidence; this alert grants no permission.",
    });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE");
    expect(state.monitor.notifications[0]?.outcome).toBe("unknown");
    expect(state.runs.A.watchdog!.alerts[0]?.acknowledgedAt).toBeUndefined();
    expect(state.runs.A.watchdog!.alerts[1]?.acknowledgedAt).toBe(1000);
    storage.close();
    storage = openPersistence(directory, [], () => at);
    Object.assign(state, storage.state);
    at = 3_600_999;
    await deliverAlerts(state, tools, () => at, save);
    expect(sent).toHaveLength(10);
    at++;
    await deliverAlerts(state, tools, () => at, save);
    expect(sent).toHaveLength(12);
    await deliverAlerts(state, tools, () => at, save);
    expect(sent).toHaveLength(12);
    expect(factoryStatus(directory).monitor?.notifications).toHaveLength(12);
    expect(
      factoryStatus(directory).runs.A!.watchdog!.alerts.filter(
        (alert) => alert.acknowledgedAt !== undefined,
      ),
    ).toHaveLength(11);
    state.runs["L".repeat(500)] = {
      ...state.runs.A,
      watchdog: {
        ...state.runs.A.watchdog!,
        alerts: [
          {
            ...state.runs.A.watchdog!.alerts[0]!,
            id: "alert-12",
          },
        ],
      },
    };
    await deliverAlerts(state, tools, () => at, save);
    expect(sent).toHaveLength(13);
    expect(String(sent[12]!.title).length).toBeLessThanOrEqual(100);
    expect(String(sent[12]!.body).length).toBeLessThanOrEqual(300);
    expect(sent[12]!.body).toContain("attempt 6");
    expect(sent[12]!.body).toContain("Incident incident-1");
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
