import type { AgentReasoningEffort } from "@ampcode/plugin";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  reviewPrompt,
  reviewVerdict,
  validReview,
  type Review,
} from "./review";
import {
  factoryStatus,
  openPersistence,
  taskSteps,
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
    role?: "reviewer",
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

/** Parse optional operator-owned worktree setup. @throws On an empty command or invalid timeout. */
export function parseSetup(command: unknown, timeout: unknown) {
  if (command === undefined) {
    if (timeout === undefined) return undefined;
    throw new Error("setupTimeoutMs requires setup");
  }
  const setup = text(command);
  const timeoutMs = timeout === undefined ? 120_000 : timeout;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    throw new Error(
      "Invalid setupTimeoutMs; expected positive milliseconds with setup",
    );
  return { command: setup, timeoutMs };
}

function isPreparation(
  run: Run | undefined,
): run is Extract<Run, { kind: "preparing" | "preparation-failed" }> {
  return run?.kind === "preparing" || run?.kind === "preparation-failed";
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

/** Resolve pstack's opposite-family adversary. @throws On unsupported providers. */
export function reviewerModel(worker: string): `${string}/${string}` {
  switch (worker.split("/")[0]) {
    case "openai":
      return "anthropic/claude-fable-5-2";
    case "anthropic":
      return "openai/gpt-6-astra";
    default:
      throw new Error(
        "Review requires an OpenAI or Anthropic implementation worker",
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
  if (raw.review !== undefined && typeof raw.review !== "boolean")
    throw new Error("Invalid review; expected boolean");
  const review = raw.review === true;
  if (review) reviewerModel(workerModel);
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
  const setup = parseSetup(raw.setup, raw.setupTimeoutMs);
  await readFile(prd, "utf8");
  return {
    workerModel,
    workerEffort,
    review,
    prd,
    tickets,
    scope,
    verify,
    setup,
    execute: permissions.execute,
  };
}

/** Parse ticket identities and dependencies at the file boundary. @throws On invalid tickets. */
export function tasks(value: unknown): Task[] {
  if (!Array.isArray(value)) throw new Error("Tickets must be an array");
  const rows = value.map((item): Task => {
    const raw = object(item);
    const id = text(raw.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid ticket ID");
    const size = raw.size;
    if (
      size !== undefined &&
      size !== "small" &&
      size !== "medium" &&
      size !== "large"
    )
      throw new Error("Invalid ticket size; expected small, medium, or large");
    const risky = raw.risky;
    if (risky !== undefined && typeof risky !== "boolean")
      throw new Error("Invalid ticket risky; expected boolean");
    return {
      id,
      brief: text(raw.brief),
      after: strings(raw.after),
      ...(raw.steps === undefined ? {} : { steps: taskSteps(raw.steps) }),
      size,
      risky,
    };
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

function requireWorktree(root: string, worktree: string) {
  if (
    !git(root, "worktree", "list", "--porcelain", "-z")
      .split("\0")
      .includes(`worktree ${worktree}`) ||
    git(worktree, "rev-parse", "--show-toplevel") !== worktree
  )
    throw new Error(
      `Preparation path is not the registered worker worktree; inspect before retrying: ${worktree}`,
    );
}

function requireSetupStopped(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM")
      throw new Error(
        `Cannot verify setup process group ${pid}; inspect its ownership and permissions before retrying`,
      );
    throw error;
  }
  throw new Error("Setup process is still alive; inspect before retrying");
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
    cleanCandidate(run, revision) &&
    allowedChanges(run.worktree, run.base, revision, scope)
    ? revision
    : null;
}

function verify(
  worktree: string,
  command: string,
  timeout = 120_000,
  onSpawn?: (pid: number) => void,
  log?: string,
) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | null;
  }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    const child = spawn(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        // Both socket stdin and inherited SSH client markers trigger Bash's remote startup.
        `${onSpawn ? "read -r ready && " : ""}exec env -u SSH_CLIENT -u SSH2_CLIENT bash -lc "$1" </dev/null`,
        "factory-command",
        command,
      ],
      {
        cwd: worktree,
        detached: true,
      },
    );
    function stop(error: Error) {
      failure = new Error(
        `${error.message}; output pipes closed; detached descendants may remain, inspect before retrying`,
      );
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure = new Error(String(error));
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
    function output(chunk: string) {
      if (!log) return;
      try {
        appendFileSync(log, chunk);
      } catch (error) {
        stop(new Error(String(error)));
      }
    }
    const timer = setTimeout(
      () => stop(new Error(`Command timed out after ${timeout}ms`)),
      timeout,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output(chunk.slice(0, Math.max(0, 1024 * 1024 - stdout.length)));
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        stdout = stdout.slice(0, 1024 * 1024);
        stop(new Error("Command stdout exceeded 1 MiB"));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output(chunk.slice(0, Math.max(0, 1024 * 1024 - stderr.length)));
      stderr += chunk;
      if (stderr.length > 1024 * 1024) {
        stderr = stderr.slice(0, 1024 * 1024);
        stop(new Error("Command stderr exceeded 1 MiB"));
      }
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.stdin.on("error", stop);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status: failure ? null : status,
        stdout,
        stderr,
        error: failure,
      });
    });
    if (onSpawn && child.pid) {
      try {
        onSpawn(child.pid);
        // A crash before the PID commit must leave setup unstarted.
        child.stdin.end("ready\n");
      } catch (error) {
        stop(new Error(String(error)));
      }
    } else child.stdin.end();
  });
}

function unchanged(worktree: string, revision: string) {
  return (
    git(worktree, "rev-parse", "HEAD") === revision &&
    !git(worktree, "status", "--porcelain")
  );
}

function cleanCandidate(
  run: Extract<Run, { kind: "running" }>,
  revision: string,
) {
  return (
    unchanged(run.worktree, revision) &&
    (!run.review || unchanged(run.review.worktree, revision))
  );
}

function reviewIdentity(root: string, worktree: string, review: Review) {
  return (
    unchanged(root, review.base) &&
    unchanged(worktree, review.revision) &&
    unchanged(review.worktree, review.revision)
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

function legacyReview(
  created: string | undefined,
  verdict: string | undefined,
) {
  const review = object(JSON.parse(text(created)));
  const rejected = object(JSON.parse(text(verdict)));
  if (
    !validReview(review) ||
    rejected.kind !== "issues" ||
    !["ticket", "attempt", "revision", "base", "stage"].every(
      (key) => rejected[key] === review[key],
    )
  )
    throw new Error("Missing pre-upgrade repair evidence");
  return review;
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
      (run) =>
        ("thread" in run && run.thread === owner) ||
        ("review" in run && run.review?.thread === owner),
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
    return `Work only in your worktree ${run.worktree}. Ticket ${task.id}: ${task.brief}\nAllowed paths: ${config.scope.join(", ")}. Check: ${config.verify}.\nDependency evidence: ${insights.join("; ") || "none"}.\n${run.feedback ? `Repair feedback: ${run.feedback}\n` : ""}Use a local commit for the change. Do not push, deploy, create tickets, edit factory files, or delegate.\nAfter finishing, write JSON to ${join(directory, `${task.id}.report.json`)}: {"attempt":${run.attempt},"kind":"candidate","revision":"<full git HEAD>","insight":"<short verified finding>"}. If blocked, use {"attempt":${run.attempt},"kind":"blocked","reason":"<needed decision>"}. Report briefly here too.`;
  }

  let stateCache: State = { enabled: false, runs: {} };
  async function reconcile(
    action: "start" | "pause" | "reconcile" | "retry-setup" | "resume",
    owner?: ThreadID,
    observe: NativeHost["state"] = host.state,
    repairRequest?: { ticket: string; decision: string },
  ) {
    const config = await configuration(root);
    const queue = tasks(JSON.parse(await readFile(config.tickets, "utf8")));
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
      async function repairCheckpoint(
        task: Task,
        blocked: Extract<Run, { kind: "blocked" }>,
      ): Promise<Extract<Run, { kind: "running" }>> {
        if (blocked.repair) return blocked.repair;
        if (!blocked.thread)
          throw new Error("No resumable verification checkpoint");
        const verdict = text(persistence!.lastEvent(task.id, "review-verdict"));
        const review = legacyReview(
          persistence!.lastEvent(task.id, "review-created"),
          verdict,
        );
        const report = (await currentReport(directory, task, 2)) ?? {};
        if (
          !Object.entries({
            ticket: task.id,
            attempt: 2,
            model: reviewerModel(config.workerModel),
            revision: report.revision,
          }).every(([key, value]) => review[key] === value) ||
          report.kind !== "candidate" ||
          report.revision !==
            git(join(directory, "worktrees", task.id), "rev-parse", "HEAD") ||
          persistence!.lastEvent(task.id, "created") !== blocked.thread ||
          blocked.reason !== `Verification failed twice: ${verdict}`
        )
          throw new Error("Missing pre-upgrade repair evidence");
        return {
          kind: "running",
          thread: blocked.thread,
          worktree: join(directory, "worktrees", task.id),
          base: text(review.base),
          attempt: 2,
          delivery: "sent",
          workerModel: config.workerModel,
          requirements: `${task.brief}\n${await readFile(config.prd, "utf8")}`,
        };
      }
      async function verifyRepair(repair: Extract<Run, { kind: "running" }>) {
        if ((await observe(repair.thread)) !== "idle")
          throw new Error(
            "Original worker must be observed idle before repair",
          );
        requireWorktree(root, repair.worktree);
        if (
          !unchanged(root, repair.base) ||
          git(repair.worktree, "status", "--porcelain")
        )
          throw new Error("Repair base or registered worker worktree changed");
      }
      async function resumeRepair() {
        if (!config.execute || text(owner) !== state.owner)
          throw new Error("Only the Foreman may resume an authorized repair");
        const ticket = text(repairRequest?.ticket);
        const decision = text(repairRequest?.decision);
        const task = queue.find((task) => task.id === ticket);
        const blocked = state.runs[ticket];
        if (!task || blocked?.kind !== "blocked")
          throw new Error(
            "Resume requires a blocked ticket with its original worker",
          );
        if (
          Object.values(state.runs).some(
            (run) => run.kind !== "blocked" && run.kind !== "done",
          )
        )
          throw new Error(
            "Resolve active or uncertain work before resuming a repair",
          );
        const repair = await repairCheckpoint(task, blocked);
        await verifyRepair(repair);
        state.runs[ticket] = {
          ...repair,
          attempt: repair.attempt + 1,
          delivery: "queued",
          feedback: `${blocked.reason}\nForeman decision: ${decision}`,
        };
        commit(
          ticket,
          "repair-resumed",
          JSON.stringify({
            decision,
            attempt: repair.attempt + 1,
            thread: repair.thread,
          }),
        );
      }
      if (action === "resume") await resumeRepair();
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
          if (run.kind === "running") {
            await watch(run.thread);
            if (run.review?.thread) await watch(run.review.thread);
          }
      }
      await watchRunning();
      if (
        Object.values(state.runs).some(
          (run) =>
            run.kind === "creating" ||
            run.kind === "uncertain" ||
            (isPreparation(run) && action !== "retry-setup"),
        )
      )
        return state;
      async function send(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
        message: string,
      ) {
        if (run.feedback && run.attempt % 2 === 1) await verifyRepair(run);
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
          !cleanCandidate(run, revision) ||
          !allowedChanges(run.worktree, run.base, revision, config.scope) ||
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
          review: run.review,
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
          if (
            config.review &&
            (task.size !== "small" || task.risky || run.attempt > 1)
          ) {
            await beginReview(task, run, revision, log);
          } else await accept(task, run, report, revision, log);
        } else await reject(task, run, log);
      }

      async function reject(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
        evidence: string,
      ) {
        delete run.review;
        if (run.attempt % 2 === 1) {
          run.attempt++;
          run.delivery = "queued";
          commit(task.id, "rejected", evidence);
        } else {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason: `Verification rejected attempt ${run.attempt}; Foreman escalation required: ${evidence}`,
            repair: run,
          };
          commit(task.id, "escalated", evidence);
        }
        if (state.runs[task.id]?.kind === "running") {
          await send(
            task,
            run,
            `Verification rejected attempt ${run.attempt - 1}. Evidence: ${evidence}. Repair the candidate and submit report attempt ${run.attempt}.\n${await prompt(task, run, config)}`,
          );
          return state;
        }
      }

      async function deliverReview(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
      ) {
        const review = run.review!;
        if (!review.thread || review.delivery !== "queued") return;
        const message = reviewPrompt(review, run.requirements!);
        review.delivery = "sending";
        commit(task.id, "review-sending", JSON.stringify(review));
        await host.send(review.thread, message);
        review.delivery = "sent";
        commit(task.id, "review-sent", JSON.stringify(review));
      }

      async function beginReview(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
        revision: string,
        log: string,
      ) {
        if (!run.workerModel)
          throw new Error(
            "Implementation provider is unknown; reconcile before review",
          );
        if (
          git(root, "rev-parse", "HEAD") !== run.base ||
          git(root, "status", "--porcelain")
        ) {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason: "Integration target changed; reconcile before landing",
          };
          commit(task.id, "blocked", "target-changed");
          return;
        }
        const model = reviewerModel(run.workerModel);
        const worktree = join(
          directory,
          "staging",
          `${task.id}-${run.attempt}-${revision}`,
        );
        const review: Review = {
          ticket: task.id,
          attempt: run.attempt,
          revision,
          base: run.base,
          stage: "post-graft",
          worktree,
          model,
          log,
          command: config.verify,
          delivery: "creating",
          report: join(
            directory,
            `${task.id}-${run.attempt}-${revision}-post-graft.review.json`,
          ),
        };
        run.review = review;
        commit(task.id, "review-creating", JSON.stringify(review));
        git(
          root,
          "worktree",
          "add",
          "-b",
          `factory-stage/${task.id}-${randomUUID()}`,
          worktree,
          run.base,
        );
        git(worktree, "merge", "--ff-only", revision);
        if (!unchanged(worktree, revision))
          throw new Error("Staged artifact changed");
        review.thread = await host.create(
          state.owner!,
          model,
          "high",
          "reviewer",
        );
        review.delivery = "queued";
        commit(task.id, "review-created", JSON.stringify(review));
        await watch(review.thread);
        await deliverReview(task, run);
      }

      async function settleReview(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
      ) {
        const review = run.review!;
        // Unknown creation/delivery remains owned and parked, including after a reload.
        if (review.delivery !== "sent") {
          if (review.delivery === "queued") await deliverReview(task, run);
          return;
        }
        if (!reviewIdentity(root, run.worktree, review)) {
          state.runs[task.id] = {
            kind: "blocked",
            thread: run.thread,
            reason:
              "Reviewed candidate or integration base changed; revalidate before landing",
          };
          commit(task.id, "blocked", "review-identity-changed");
          return;
        }
        if ((await observe(review.thread!)) !== "idle") return;
        const verdict = await reviewVerdict(review);
        if (!verdict) return;
        review.evidence = verdict.evidence;
        commit(task.id, "review-verdict", verdict.evidence);
        if (verdict.kind === "issues")
          return reject(task, run, verdict.evidence);
        const report = await currentReport(directory, task, run.attempt);
        if (!report || candidate(run, report, config.scope) !== review.revision)
          return;
        await accept(
          task,
          run,
          report,
          review.revision,
          `${review.log}; ${review.report}`,
        );
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

      async function createWorker(task: Task, base: string, worktree: string) {
        if (state.runs[task.id]?.kind !== "creating") {
          state.runs[task.id] = { kind: "creating", base, worktree };
          commit(task.id, "creating", base);
        }
        const thread = await host.create(
          state.owner!,
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
          workerModel: config.workerModel,
          requirements: `${task.brief}\n${await readFile(config.prd, "utf8")}`,
        };
        state.runs[task.id] = run;
        commit(task.id, "created", thread);
        await watch(thread);
        await send(task, run, await prompt(task, run, config));
        return state;
      }

      async function prepare(task: Task, base: string, worktree: string) {
        if (!config.setup)
          throw new Error("Configure setup before retrying preparation");
        const run: Extract<Run, { kind: "preparing" }> = {
          kind: "preparing",
          base,
          worktree,
          command: config.setup.command,
          timeoutMs: config.setup.timeoutMs,
          log: join(directory, `${task.id}-setup-${randomUUID()}.log`),
        };
        await writeFile(
          run.log,
          `Command: ${run.command}\nWorktree: ${worktree}\nTimeout: ${run.timeoutMs}ms\n`,
        );
        state.runs[task.id] = run;
        commit(task.id, "preparing", JSON.stringify(run));
        try {
          if (!existsSync(worktree)) addWorktree(task, base, worktree);
          requireWorktree(root, worktree);
          if (git(worktree, "rev-parse", "HEAD") !== base)
            throw new Error("Preparation worktree revision changed");
          const result = await verify(
            worktree,
            run.command,
            run.timeoutMs,
            (pid) => {
              run.pid = pid;
              commit(task.id, "setup-spawned", JSON.stringify(run));
            },
            run.log,
          );
          delete run.pid;
          commit(task.id, "setup-finished", run.log);
          await writeFile(
            run.log,
            `${await readFile(run.log, "utf8")}\nStatus: ${result.status}\n${result.error ?? ""}`,
          );
          if (result.status !== 0)
            throw new Error(
              `Setup failed (${result.status ?? result.error}): ${run.log}`,
            );
          if (!unchanged(worktree, base))
            throw new Error(
              `Setup must leave the worktree clean at ${base}: ${git(worktree, "status", "--porcelain")}`,
            );
        } catch (error) {
          const reason = String(error);
          state.runs[task.id] = { ...run, kind: "preparation-failed", reason };
          commit(
            task.id,
            "preparation-failed",
            JSON.stringify({ log: run.log, reason }),
          );
          return state;
        }
        return createWorker(task, base, worktree);
      }

      function addWorktree(task: Task, base: string, worktree: string) {
        git(
          root,
          "worktree",
          "add",
          "-b",
          `feat/${task.id}-${randomUUID().slice(0, 8)}`,
          worktree,
          base,
        );
      }

      async function dispatchNext() {
        if (
          Object.values(state.runs).some(
            (run) =>
              run.kind === "running" || (run.kind === "blocked" && run.repair),
          )
        )
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
        if (config.setup) return prepare(next, base, worktree);
        state.runs[next.id] = { kind: "creating", base, worktree };
        commit(next.id, "creating", base);
        addWorktree(next, base, worktree);
        return createWorker(next, base, worktree);
      }

      async function settleRuns() {
        if (action === "retry-setup") {
          await retrySetup();
          return true;
        }
        for (const task of queue) {
          const run = state.runs[task.id];
          if (run?.kind === "running") {
            const result = run.review
              ? await settleReview(task, run)
              : await settle(task, run);
            if (result) return true;
          }
        }
        return false;
      }
      async function retrySetup() {
        for (const task of queue) {
          const run = state.runs[task.id];
          if (!isPreparation(run)) continue;
          requireSetupStopped(run.pid);
          if (git(root, "status", "--porcelain"))
            throw new Error("Commit existing changes before retrying setup");
          const base = git(root, "rev-parse", "HEAD");
          if (base !== run.base && existsSync(run.worktree)) {
            requireWorktree(root, run.worktree);
            if (git(run.worktree, "status", "--porcelain"))
              throw new Error(
                "Preparation worktree has local changes; reconcile before retrying setup",
              );
            git(run.worktree, "merge", "--ff-only", base);
          }
          return prepare(task, base, run.worktree);
        }
        throw new Error("No preparation to retry");
      }
      if (!(await settleRuns())) await dispatchNext();
      return state;
    } finally {
      persistence?.close();
      await store.close();
    }
  }

  /** Serialize local callbacks; the poteto lock excludes other plugin processes. @throws On unsafe state or failed I/O. */
  function tick(
    action:
      "status" | "start" | "pause" | "reconcile" | "retry-setup" | "resume",
    owner?: ThreadID,
    observe: NativeHost["state"] = host.state,
    repairRequest?: Parameters<typeof reconcile>[3],
  ): Promise<State> {
    const result = pending
      .catch(() => {})
      .then(async () => {
        if (action === "status") {
          await configuration(root);
          return factoryStatus(directory);
        }
        return reconcile(action, owner, observe, repairRequest);
      });
    pending = result;
    return result;
  }
  return { tick, directory };
}
