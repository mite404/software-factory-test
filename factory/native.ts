import type { AgentReasoningEffort } from "@ampcode/plugin";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  factoryStatus,
  openPersistence,
  type ThreadID,
  type Task,
  type Run,
  type State,
} from "./persistence";

/** The existing poteto store supplies the cross-process lock and revision ledger. */
export type Bookkeeping = {
  init(): Promise<unknown>;
  close(): Promise<void>;
  ledger: {
    record(entry: {
      pr: number;
      sha: string;
      verdict: "unit-test-verified";
      evidence: string;
    }): Promise<unknown>;
  };
};

/** Remote operations only; local state, commands, and verification stay real in tests. */
export type NativeHost = {
  /** Create a worker; omitted effort preserves Amp's model default. */
  create(
    parent: ThreadID,
    model: `${string}/${string}`,
    effort?: AgentReasoningEffort,
  ): Promise<ThreadID>;
  send(thread: ThreadID, message: string): Promise<void>;
  /** Observe activity; unavailable evidence is unknown and preserves running ownership. */
  state(
    this: void,
    thread: ThreadID,
  ): Promise<"idle" | "running" | "awaiting-approval" | "error" | "unknown">;
  watch(thread: ThreadID, wake: () => void): void;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return { ...value };
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Expected nonempty text");
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected string array");
  return value.map(text);
}

/** Parse native worker effort; omission keeps the model default. @throws On unsupported values. */
export function parseWorkerEffort(
  value: unknown,
): AgentReasoningEffort | undefined {
  switch (value) {
    case undefined:
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      throw new Error(
        "Invalid workerEffort; expected none, minimal, low, medium, high, xhigh, or max",
      );
  }
}

/** Resolve a repository-relative input and reject escapes, including symlinks. @throws On escape. */
export function localPath(root: string, value: string): string {
  const path = resolve(root, value);
  if (isAbsolute(value) || relative(root, path).startsWith(".."))
    throw new Error("Path escapes repository");
  const actual = execFileSync("realpath", ["-m", path], {
    encoding: "utf8",
  }).trim();
  if (relative(root, actual).startsWith(".."))
    throw new Error("Symlink escapes repository");
  return path;
}

/** Parse trusted operator configuration; setup does not grant action permissions. @throws On invalid input. */
export async function configuration(root: string) {
  const raw = object(
    JSON.parse(await readFile(join(root, ".factory.json"), "utf8")),
  );
  if (raw.version !== 1 || raw.capacity !== 1)
    throw new Error("This slice requires version 1 and capacity 1");
  const permissions = object(raw.permissions);
  if (
    typeof permissions.execute !== "boolean" ||
    permissions.publish !== false ||
    permissions.externalTickets !== false
  )
    throw new Error(
      "Only local execution is supported; publishing and external tickets must stay disabled",
    );
  const model = text(raw.workerModel);
  if (!model.includes("/")) throw new Error("Expected provider/model");
  const [provider, ...name] = model.split("/");
  const workerModel: `${string}/${string}` = `${provider}/${name.join("/")}`;
  const workerEffort = parseWorkerEffort(raw.workerEffort);
  const prd = localPath(root, text(raw.prd));
  const tickets = localPath(root, text(raw.tickets));
  const scope = strings(raw.scope);
  if (!scope.length) throw new Error("At least one allowed path is required");
  for (const path of scope) {
    localPath(root, path);
    if (
      path === "." ||
      path.startsWith(".git") ||
      path.startsWith(".amp") ||
      path.startsWith(".factory")
    )
      throw new Error(
        "Scope must exclude factory configuration and runtime files",
      );
  }
  const verify = text(raw.verify);
  await readFile(prd, "utf8");
  return {
    workerModel,
    workerEffort,
    prd,
    tickets,
    scope,
    verify,
    execute: permissions.execute,
  };
}

/** Parse ticket identities and dependencies at the file boundary. @throws On invalid tickets. */
export function tasks(value: unknown): Task[] {
  if (!Array.isArray(value)) throw new Error("Tickets must be an array");
  const rows = value.map((item) => {
    const raw = object(item);
    const id = text(raw.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid ticket ID");
    return { id, brief: text(raw.brief), after: strings(raw.after) };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Duplicate ticket ID");
  for (const row of rows)
    for (const id of row.after)
      if (id === row.id || !rows.some((other) => other.id === id))
        throw new Error("Invalid dependency");
  return rows;
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function allowedChanges(
  worktree: string,
  base: string,
  revision: string,
  scope: string[],
) {
  const changed = git(worktree, "diff", "--name-only", base, revision)
    .split("\n")
    .filter(Boolean);
  return (
    changed.length > 0 &&
    changed.every((path) =>
      scope.some(
        (prefix) =>
          path === prefix || (prefix.endsWith("/") && path.startsWith(prefix)),
      ),
    )
  );
}

function candidate(
  run: Extract<Run, { kind: "running" }>,
  report: Record<string, unknown>,
  scope: string[],
) {
  const revision = git(run.worktree, "rev-parse", "HEAD");
  return report.revision === revision &&
    revision !== run.base &&
    !git(run.worktree, "status", "--porcelain") &&
    allowedChanges(run.worktree, run.base, revision, scope)
    ? revision
    : null;
}

function verify(worktree: string, command: string) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | null;
  }>((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd: worktree,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const status =
          typeof error?.code === "number" ? error.code : error ? null : 0;
        resolve({
          status,
          stdout,
          stderr,
          error: status === null ? error : null,
        });
      },
    );
  });
}

function unchanged(worktree: string, revision: string) {
  return (
    git(worktree, "rev-parse", "HEAD") === revision &&
    !git(worktree, "status", "--porcelain")
  );
}

async function candidateEvidence(
  directory: string,
  task: Task,
  run: Extract<Run, { kind: "running" }>,
  report: Record<string, unknown>,
  config: Awaited<ReturnType<typeof configuration>>,
) {
  const revision = candidate(run, report, config.scope);
  const result = revision ? await verify(run.worktree, config.verify) : null;
  const log = join(directory, `${task.id}-${run.attempt}.log`);
  await writeFile(
    log,
    result
      ? `${result.stdout}${result.stderr}${result.error ?? ""}`
      : "Candidate revision, clean tree, or allowed-path check failed",
  );
  const accepted =
    revision && result?.status === 0 && unchanged(run.worktree, revision);
  return { revision: accepted ? revision : null, log };
}

async function currentReport(directory: string, task: Task, attempt: number) {
  const path = join(directory, `${task.id}.report.json`);
  if (!existsSync(path)) return null;
  const report = object(JSON.parse(await readFile(path, "utf8")));
  return report.attempt === attempt ? report : null;
}

function controlState(
  state: State,
  action: string,
  execute: boolean,
  owner?: ThreadID,
) {
  if (
    owner &&
    Object.values(state.runs).some(
      (run) => "thread" in run && run.thread === owner,
    )
  )
    throw new Error("Workers cannot control the factory");
  if (action === "start") {
    if (!execute)
      throw new Error(
        "Grant permissions.execute in .factory.json before starting",
      );
    state.owner ??= owner;
    if (!state.owner) throw new Error("Starting requires an owner thread");
    state.enabled = true;
  }
  if (action === "pause") state.enabled = false;
}

function restoreTickets(queue: Task[], persisted: Task[], state: State) {
  for (const task of persisted)
    if (state.runs[task.id] && !queue.some((row) => row.id === task.id))
      queue.push(task);
}

/** Create the sequential dispatcher. Unknown remote effects are parked, never retried blindly. */
export function createFactory(
  root: string,
  host: NativeHost,
  openStore: (directory: string) => Bookkeeping,
) {
  const directory = join(
    git(root, "rev-parse", "--absolute-git-dir"),
    "factory",
  );
  const watched = new Set<ThreadID>();
  let pending = Promise.resolve<unknown>(undefined);

  async function event(ticket: string, action: string, detail: string) {
    const persistence = openPersistence(directory, []);
    try {
      persistence.event(ticket, action, detail);
    } finally {
      persistence.close();
    }
  }

  async function prompt(
    task: Task,
    run: Extract<Run, { kind: "running" }>,
    config: Awaited<ReturnType<typeof configuration>>,
  ) {
    const dependencies = stateCache.runs;
    const insights = task.after.flatMap((id) => {
      const dependency = dependencies[id];
      return dependency?.kind === "done"
        ? [`${id}: ${dependency.insight} (${dependency.revision})`]
        : [];
    });
    return `Work only in your worktree ${run.worktree}. Ticket ${task.id}: ${task.brief}\nAllowed paths: ${config.scope.join(", ")}. Check: ${config.verify}.\nDependency evidence: ${insights.join("; ") || "none"}.\nUse a local commit for the change. Do not push, deploy, create tickets, edit factory files, or delegate.\nAfter finishing, write JSON to ${join(directory, `${task.id}.report.json`)}: {"attempt":${run.attempt},"kind":"candidate","revision":"<full git HEAD>","insight":"<short verified finding>"}. If blocked, use {"attempt":${run.attempt},"kind":"blocked","reason":"<needed decision>"}. Report briefly here too.`;
  }

  let stateCache: State = { enabled: false, runs: {} };
  async function reconcile(
    action: "status" | "start" | "pause" | "reconcile",
    owner?: ThreadID,
    observe: NativeHost["state"] = host.state,
  ) {
    const config = await configuration(root);
    const queue = tasks(JSON.parse(await readFile(config.tickets, "utf8")));
    if (action === "status") return factoryStatus(directory);
    await mkdir(directory, { recursive: true });
    const store = openStore(join(directory, "bookkeeping"));
    let persistence: ReturnType<typeof openPersistence> | undefined;
    try {
      await store.init();
      persistence = openPersistence(directory, queue);
      const state = persistence.state;
      restoreTickets(queue, persistence.tickets, state);
      const commit = (ticket: string, action: string, detail: string) =>
        persistence!.commit(state, ticket, action, detail);
      stateCache = state;
      controlState(state, action, config.execute, owner);
      if (action === "start") commit("factory", "started", state.owner!);
      if (action === "pause") commit("factory", "paused", state.owner ?? "");
      if (!state.enabled || !config.execute) return state;
      const wake = () => {
        void tick("reconcile").catch((error) =>
          event("factory", "error", String(error)),
        );
      };
      const watch = async (thread: ThreadID) => {
        if (watched.has(thread)) return;
        try {
          host.watch(thread, wake);
          watched.add(thread);
        } catch (error) {
          await event("factory", "observation-unavailable", String(error));
        }
      };
      async function watchRunning() {
        for (const run of Object.values(state.runs))
          if (run.kind === "running") await watch(run.thread);
      }
      await watchRunning();
      if (
        Object.values(state.runs).some(
          (run) => run.kind === "creating" || run.kind === "uncertain",
        )
      )
        return state;
      async function send(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
        message: string,
      ) {
        run.delivery = "sending";
        commit(task.id, "sending", run.thread);
        await host.send(run.thread, message);
        run.delivery = "sent";
        commit(task.id, "sent", run.thread);
      }

      async function accept(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
        report: Record<string, unknown>,
        revision: string,
        log: string,
      ) {
        const target = git(root, "rev-parse", "HEAD");
        if (
          git(root, "status", "--porcelain") ||
          (target !== run.base && target !== revision)
        ) {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason: "Integration target changed; reconcile before landing",
          };
          commit(task.id, "blocked", "target-changed");
          return;
        }
        if (target !== revision) git(root, "merge", "--ff-only", revision);
        await store.ledger.record({
          pr: queue.indexOf(task) + 1,
          sha: revision,
          verdict: "unit-test-verified",
          evidence: log,
        });
        state.runs[task.id] = {
          kind: "done",
          thread: run.thread,
          revision,
          insight:
            typeof report.insight === "string"
              ? report.insight.slice(0, 1000)
              : "",
        };
        commit(task.id, "accepted", revision);
      }

      async function checkCandidate(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
        report: Record<string, unknown>,
      ) {
        const { revision, log } = await candidateEvidence(
          directory,
          task,
          run,
          report,
          config,
        );
        if (revision) {
          await accept(task, run, report, revision, log);
        } else if (run.attempt < 2) {
          run.attempt++;
          run.delivery = "queued";
          commit(task.id, "rejected", log);
        } else {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason: `Verification failed twice: ${log}`,
          };
          commit(task.id, "blocked", log);
        }
        if (state.runs[task.id]?.kind === "running") {
          await send(
            task,
            run,
            `Verification rejected attempt ${run.attempt - 1}. Read ${log}, repair the candidate, and submit report attempt ${run.attempt}.\n${await prompt(task, run, config)}`,
          );
          return state;
        }
      }

      async function settle(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
      ) {
        if (run.delivery === "sending") {
          state.runs[task.id] = {
            kind: "uncertain",
            thread: run.thread,
            reason: "Delivery outcome unknown; inspect thread before recovery",
          };
          commit(task.id, "uncertain", "delivery-unknown");
          return state;
        }
        if (run.delivery === "queued") {
          await send(task, run, await prompt(task, run, config));
          return;
        }
        const activity = await observe(run.thread);
        if (activity === "running" || activity === "unknown") return;
        if (activity !== "idle") {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason: `Worker ${activity}; inspect before resuming`,
          };
          commit(task.id, "blocked", activity);
          return;
        }
        const report = await currentReport(directory, task, run.attempt);
        if (!report) return;
        if (report.kind === "blocked") {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason: text(report.reason),
          };
          commit(task.id, "blocked", text(report.reason));
          return;
        }
        if (report.kind !== "candidate")
          throw new Error("Invalid worker report");
        return checkCandidate(task, run, report);
      }

      async function dispatchNext() {
        if (Object.values(state.runs).some((run) => run.kind === "running"))
          return state;
        const next = queue.find(
          (task) =>
            !state.runs[task.id] &&
            task.after.every((id) => state.runs[id]?.kind === "done"),
        );
        if (!next || !state.owner) return state;
        if (git(root, "status", "--porcelain"))
          throw new Error("Commit existing changes before dispatch");
        const base = git(root, "rev-parse", "HEAD");
        const worktree = join(directory, "worktrees", next.id);
        state.runs[next.id] = { kind: "creating", base, worktree };
        commit(next.id, "creating", base);
        git(
          root,
          "worktree",
          "add",
          "-b",
          `feat/${next.id}-${randomUUID().slice(0, 8)}`,
          worktree,
          base,
        );
        const thread = await host.create(
          state.owner,
          config.workerModel,
          config.workerEffort,
        );
        const run: Extract<Run, { kind: "running" }> = {
          kind: "running",
          base,
          worktree,
          thread,
          attempt: 1,
          delivery: "queued",
        };
        state.runs[next.id] = run;
        commit(next.id, "created", thread);
        await watch(thread);
        await send(next, run, await prompt(next, run, config));
        return state;
      }

      async function settleRunning() {
        for (const task of queue) {
          const run = state.runs[task.id];
          if (run?.kind === "running" && (await settle(task, run))) return true;
        }
        return false;
      }
      if (!(await settleRunning())) await dispatchNext();
      return state;
    } finally {
      persistence?.close();
      await store.close();
    }
  }

  /** Serialize local callbacks; the poteto lock excludes other plugin processes. @throws On unsafe state or failed I/O. */
  function tick(
    action: "status" | "start" | "pause" | "reconcile",
    owner?: ThreadID,
    observe: NativeHost["state"] = host.state,
  ): Promise<State> {
    const result = pending
      .catch(() => {})
      .then(() => reconcile(action, owner, observe));
    pending = result;
    return result;
  }
  return { tick, directory };
}
