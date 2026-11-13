import { expect, test } from "bun:test";
import type { PluginAPI, PluginToolContext } from "@ampcode/plugin";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "./dashboard";
import registerFactory from "./plugin";
import { openPersistence } from "./persistence";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

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
  "valid",
  "revision",
  "dirty",
  "scope",
  "verification",
  "integration",
  "permission",
  "responsive",
  "review",
])(
  "disconnected recovery preserves ownership and the %s gate",
  async (gate) => {
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
        JSON.stringify([{ id: "A", brief: "Repair value", after: [] }]),
      );
      await writeFile(
        join(root, ".factory.json"),
        JSON.stringify({
          version: 1,
          capacity: 1,
          workerModel: "openai/gpt-6.1-sol",
          review: gate === "review",
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
      const models: {
        model: string;
        reasoningEffort?: string;
        instructions: string;
      }[] = [];
      const sends: string[] = [];
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
      let execute!: (
        input: { action: string },
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
        createAgent(options: {
          model: string;
          reasoningEffort?: string;
          instructions: string;
        }) {
          models.push(options);
          return {
            async createThread() {
              creates++;
              return { id: ["T-worker", "T-reviewer"][creates - 1] };
            },
          };
        },
        threads: {
          get(id: string) {
            return {
              async appendUserMessage() {
                sends.push(id);
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
        registerTool(tool: { execute: typeof execute }) {
          execute = tool.execute;
        },
        onDispose(fn: () => void) {
          dispose = fn;
        },
      } as unknown as PluginAPI;
      const ctx = {
        thread: { id: "T-owner" },
        tools: {
          async call(name: string, input: unknown) {
            expect(name).toBe("amp.get_thread_status");
            expect(input).toEqual({ thread: "T-worker" });
            fallbackCalls++;
            if (fallbackFails) throw new Error("status unavailable");
            return payload;
          },
        },
      } as unknown as PluginToolContext;
      const control = async (action: string, context = ctx) =>
        JSON.parse(String(await execute({ action }, context)));
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
      expect(original).toMatchObject({
        kind: "running",
        thread: "T-worker",
        attempt: 1,
        delivery: "sent",
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
          .tasks[0].status,
      ).toBe("idle");
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
        git(worktree, "reset", "--hard", revision);
        await writeFile(
          reportPath,
          JSON.stringify({ kind: "candidate", attempt: 2, revision }),
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
        disconnected = false;
        const pending = (await control("reconcile")).runs.A;
        expect(pending).toMatchObject({
          kind: "running",
          review: {
            stage: "post-graft",
            thread: "T-reviewer",
            delivery: "sent",
          },
        });
        expect(ledger).toEqual([]);
        expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
        expect(models[1]).toMatchObject({
          model: "anthropic/claude-fable-5-2",
          reasoningEffort: "high",
        });
        expect(models[1]?.instructions).toContain("Do not implement");
        const dashboard = await Bun.file(
          join(root, ".git/factory/dashboard.json"),
        ).json();
        expect(dashboard.tasks[0]).toMatchObject({
          thread: "T-reviewer",
          revision,
        });
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
      expect(sends).toEqual(
        Array(
          ["valid", "permission", "responsive"].includes(gate) ? 1 : 2,
        ).fill("T-worker"),
      );

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
        get() {
          return {
            async appendUserMessage() {
              sends++;
            },
            state: {
              async get() {
                return "running";
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
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
      onDispose(fn: () => void) {
        dispose = fn;
      },
    } as unknown as PluginAPI;
    const ctx = { thread: { id: "T-owner" } } as unknown as PluginToolContext;
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
    load();
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
    dispose();
    load();
    expect((await control("reconcile")).runs.A).toEqual(failed);
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
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
