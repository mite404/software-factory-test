import type { AgentReasoningEffort, PluginTools } from "@ampcode/plugin";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import definitionSchema from "./definition.schema.json";
import {
  deliverAlerts,
  reconcileSchedule,
  WatchdogUnavailable,
} from "./watchdog";
import {
  reviewPrompt,
  reviewVerdict,
  validReview,
  type Review,
} from "./review";
import {
  factoryStatus,
  factoryDefinition,
  openPersistence,
  taskSteps,
  defaultWatchdog,
  validWatchdogPolicy,
  type ThreadID,
  type Task,
  type Run,
  type DefinitionPin,
  type StopIncident,
  type State,
  type Watchdog,
  type WatchdogPolicy,
} from "./persistence";

const activityReasons = {
  error: "worker-error",
  "awaiting-approval": "approval-required",
} as const;

const progressActions = new Set([
  "preparing",
  "setup-finished",
  "creating",
  "created",
  "sent",
  "rejected",
  "repair-resumed",
  "review-sent",
  "review-verdict",
  "review-recovered",
  "accepted",
  "blocked",
  "escalated",
  "review-stopped",
  "preparation-failed",
  "uncertain",
  "stop-recorded",
]);

function watchdogPolicy(value: unknown): WatchdogPolicy {
  if (value === undefined) return defaultWatchdog;
  if (!validWatchdogPolicy(value))
    throw new Error("Invalid watchdog policy; expected positive safe integers");
  return value;
}

function watchdogProgress(
  run: Run,
  previous: Watchdog | undefined,
  action: string,
  at: number,
): Watchdog {
  const timing = run.watchdog ?? previous;
  if (timing && !progressActions.has(action)) return timing;
  const prior = previous ?? timing ?? { attempt: 0, alerts: [] };
  const source = checkpointIdentity(run) ?? prior;
  return {
    episode: run.incident ? run.incident.id : randomUUID(),
    progressAt: at,
    attempt: source.attempt,
    alerts: prior.alerts,
  };
}

function watchdogDue(timing: Watchdog, policy: WatchdogPolicy, at: number) {
  return {
    spending:
      timing.attempt >= policy.spendingFirstAttempt &&
      (timing.attempt - policy.spendingFirstAttempt) %
        policy.spendingInterval ===
        0 &&
      !timing.alerts.some(
        (alert) =>
          alert.kind === "spending" && alert.attempt === timing.attempt,
      ),
    nudge:
      at - timing.progressAt >= policy.suspicionMs &&
      at - (timing.nudgedAt ?? timing.progressAt) >= policy.suspicionMs,
  };
}

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

function backupTarget(value: unknown) {
  if (value === undefined) return undefined;
  const raw = object(value);
  knownKeys(raw, definitionSchema.properties.backup.properties);
  const { repository, projectKey } = raw;
  if (
    typeof repository !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(
      repository,
    ) ||
    repository.includes("..") ||
    typeof projectKey !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(projectKey)
  )
    throw new Error("Invalid backup repository or project key");
  return { repository, projectKey };
}

function knownKeys(raw: Record<string, unknown>, properties: object) {
  for (const key of Object.keys(raw))
    if (!Object.hasOwn(properties, key))
      throw new Error(`Unsupported definition setting ${key}`);
}

function actionPermissions(raw: Record<string, unknown>) {
  const permissions = object(raw.permissions);
  knownKeys(permissions, definitionSchema.properties.permissions.properties);
  const backup = backupTarget(raw.backup);
  if (
    permissions.backup !== undefined &&
    typeof permissions.backup !== "boolean"
  )
    throw new Error("Invalid backup permission");
  if (
    typeof permissions.execute !== "boolean" ||
    permissions.publish !== false ||
    permissions.externalTickets !== false
  )
    throw new Error(
      "Only local execution is supported; publishing and external tickets must stay disabled",
    );
  return {
    execute: permissions.execute,
    backup,
    backupAllowed: permissions.backup === true,
  };
}

function workerRole(raw: Record<string, unknown>) {
  const model = text(raw.workerModel);
  if (!/^[^/]+\/.+$/.test(model)) throw new Error("Expected provider/model");
  const [provider, ...name] = model.split("/");
  const workerModel: `${string}/${string}` = `${provider}/${name.join("/")}`;
  const workerEffort = parseWorkerEffort(raw.workerEffort);
  if (raw.review !== undefined && typeof raw.review !== "boolean")
    throw new Error("Invalid review; expected boolean");
  const review = raw.review === true;
  if (review) reviewerModel(workerModel);
  return { workerModel, workerEffort, review };
}

function allowedScope(root: string, value: unknown) {
  const scope = strings(value);
  if (!scope.length) throw new Error("At least one allowed path is required");
  for (const path of scope) {
    const normalized = relative(root, localPath(root, path));
    if (
      normalized === "" ||
      [".git", ".amp", ".factory"].some((prefix) =>
        normalized.startsWith(prefix),
      ) ||
      normalized === "factory/definition.yaml"
    )
      throw new Error(
        "Scope must exclude factory configuration and runtime files",
      );
  }
  return scope;
}

async function validateConfiguration(
  root: string,
  raw: Record<string, unknown>,
) {
  knownKeys(raw, definitionSchema.properties);
  if (raw.version !== 1 || raw.capacity !== 1)
    throw new Error("This slice requires version 1 and capacity 1");
  if (raw.mode !== undefined) text(raw.mode);
  if (
    raw.orchestratorModel !== undefined &&
    !/^[^/]+\/.+$/.test(text(raw.orchestratorModel))
  )
    throw new Error("Expected orchestrator provider/model");
  if (
    raw.bookkeepingSHA256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(text(raw.bookkeepingSHA256))
  )
    throw new Error("Invalid bookkeeping digest");
  const role = workerRole(raw);
  const permissions = actionPermissions(raw);
  const prd = localPath(root, text(raw.prd));
  const tickets = localPath(root, text(raw.tickets));
  const scope = allowedScope(root, raw.scope);
  const verify = text(raw.verify);
  const setup = parseSetup(raw.setup, raw.setupTimeoutMs);
  const watchdog = watchdogPolicy(raw.watchdog);
  const instructions = await readFile(prd, "utf8");
  tasks(JSON.parse(await readFile(tickets, "utf8")));
  return {
    ...role,
    ...permissions,
    prd,
    tickets,
    scope,
    verify,
    setup,
    watchdog,
    instructions,
  };
}

/** Resolve one authored definition without running project commands or mutating state. @throws On conflicts or invalid inputs. */
export async function configuration(root: string) {
  const yaml = localPath(root, "factory/definition.yaml");
  const legacy = localPath(root, ".factory.json");
  if (existsSync(yaml) && existsSync(legacy))
    throw new Error("Conflicting definitions; finish explicit --migrate first");
  const source = existsSync(yaml) ? yaml : legacy;
  const content = await readFile(source, "utf8");
  const raw = object(
    source === yaml ? Bun.YAML.parse(content) : JSON.parse(content),
  );
  const config = await validateConfiguration(root, raw);
  const digest = createHash("sha256")
    .update(content)
    .update("\0")
    .update(config.instructions)
    .digest("hex");
  return { ...config, digest };
}

/** Move the legacy definition to its YAML home explicitly, retaining bytes, ownership and mode. @throws On invalid or conflicting definitions. */
export async function migrateDefinition(root: string) {
  const yaml = localPath(root, "factory/definition.yaml");
  const legacy = localPath(root, ".factory.json");
  if (existsSync(yaml) && existsSync(legacy)) {
    const [old, migrated] = await Promise.all([lstat(legacy), lstat(yaml)]);
    if (!old.isFile() || old.dev !== migrated.dev || old.ino !== migrated.ino)
      throw new Error(
        "Conflicting definitions; migration refuses to overwrite project edits",
      );
    await validateConfiguration(
      root,
      object(Bun.YAML.parse(await readFile(yaml, "utf8"))),
    );
    await unlink(legacy);
    return;
  }
  await configuration(root);
  if (existsSync(yaml)) return;
  if (!(await lstat(legacy)).isFile())
    throw new Error("Migration requires a regular definition file");
  await mkdir(join(root, "factory"), { recursive: true });
  // JSON is YAML 1.2. Linking retains metadata and cannot overwrite a concurrently authored file.
  await link(legacy, yaml);
  await unlink(legacy);
}

/** Return only public-safe capabilities, never commands, instructions, paths or backup targets. @throws On invalid definitions. */
export async function effectiveDefinition(root: string) {
  const config = await effectiveConfiguration(root);
  return {
    version: 1,
    digest: config.digest,
    permissions: {
      execute: config.execute,
      backup: config.backupAllowed,
      publish: false,
      externalTickets: false,
    },
    capabilities: { review: config.review, setup: config.setup !== undefined },
  };
}

/** Resolve the durable loaded definition with current, never pinned, permissions. @throws On invalid project or stored definitions. */
export async function effectiveConfiguration(root: string) {
  const current = await configuration(root);
  const loaded = factoryDefinition(
    join(git(root, "rev-parse", "--absolute-git-dir"), "factory"),
  );
  return loaded
    ? {
        ...current,
        ...loaded,
        setup: loaded.setup,
        watchdog: loaded.watchdog ?? defaultWatchdog,
        workerEffort: loaded.workerEffort,
      }
    : current;
}

function definitionPin(
  config: Awaited<ReturnType<typeof configuration>>,
): DefinitionPin {
  const {
    digest,
    scope,
    verify,
    review,
    workerModel,
    workerEffort,
    instructions,
    tickets,
    setup,
    watchdog,
  } = config;
  return {
    digest,
    scope,
    verify,
    review,
    workerModel,
    ...(workerEffort === undefined ? {} : { workerEffort }),
    instructions,
    tickets,
    setup,
    watchdog,
  };
}

function runDefinition(
  run: Run,
  config: Awaited<ReturnType<typeof configuration>>,
  directory: string,
): DefinitionPin {
  return run.definition
    ? factoryDefinition(directory, run.definition)!
    : config;
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
  const changed = git(
    worktree,
    "diff",
    "--no-renames",
    "--name-only",
    base,
    revision,
  )
    .split("\n")
    .filter(Boolean);
  return (
    changed.length > 0 &&
    changed.every(
      (path) =>
        path !== "factory/definition.yaml" &&
        scope.some(
          (prefix) =>
            path === prefix ||
            (prefix.endsWith("/") && path.startsWith(prefix)),
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
  // ponytail: fixed gate budget; the full gate already takes ~95s. Make it a definition
  // setting when a project's gate legitimately needs longer than ten minutes.
  timeout = 600_000,
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
  const pinned = runDefinition(run, config, directory);
  const revision = candidate(run, report, pinned.scope);
  const result = revision ? await verify(run.worktree, pinned.verify) : null;
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

/** Refuse control by persisted workers and reviewers. @throws If the caller owns either role. */
export function assertControlCaller(state: State, owner?: ThreadID) {
  if (
    owner &&
    Object.values(state.runs).some(
      (run) =>
        ("thread" in run && run.thread === owner) ||
        ("review" in run && run.review?.thread === owner),
    )
  )
    throw new Error("Workers cannot control the factory");
}

function assertWatchdogCaller(
  state: State,
  action: string,
  owner?: ThreadID,
  tools?: PluginTools,
) {
  if (!tools) return;
  const expected =
    state.owner ??
    (action === "start"
      ? owner
      : action === "pause"
        ? state.monitor?.pendingThread
        : undefined);
  if (action === "status" || !owner || owner !== expected)
    throw new Error("Watchdog effects require the connected owning Foreman");
}

function controlState(
  state: State,
  action: string,
  execute: boolean,
  savePause: () => void,
  owner?: ThreadID,
) {
  assertControlCaller(state, owner);
  if (action === "start") {
    if (!execute)
      throw new Error(
        "Grant permissions.execute in the project definition before starting",
      );
    if (!state.owner && !owner)
      throw new Error("Starting requires an owner thread");
    state.enabled = true;
  }
  if (action === "pause") {
    state.enabled = false;
    // Local stop must survive failed inspection, changed roots and remote clear failures.
    savePause();
  }
}

function restoreTickets(queue: Task[], persisted: Task[], state: State) {
  for (const task of persisted)
    if (state.runs[task.id] && !queue.some((row) => row.id === task.id))
      queue.push(task);
}

function retryAdmission(state: State, action: string) {
  if (action !== "retry-setup") return true;
  const runs = Object.values(state.runs);
  if (runs.some((run) => run.kind === "creating" || run.kind === "uncertain"))
    return false;
  if (!state.enabled || !runs.some(isPreparation))
    throw new Error("No preparation to retry");
  return true;
}

function checkpointIdentity(run?: Run) {
  if (!run) return undefined;
  const checkpoint =
    run.kind === "blocked" ? (run.repair ?? run.checkpoint) : run;
  if (!checkpoint || !("base" in checkpoint)) return undefined;
  return {
    base: checkpoint.base,
    attempt: "attempt" in checkpoint ? checkpoint.attempt : 0,
  };
}

function stoppedRun(
  run: Run,
  reason?: StopIncident["reason"],
): [StopIncident["reason"], StopIncident["recovery"]] | undefined {
  if (run.kind === "blocked")
    return [
      reason ?? (run.repair ? "verification-rejected" : "worker-blocked"),
      run.repair || run.checkpoint ? "resume" : "inspect",
    ];
  if (run.kind === "preparation-failed")
    return ["preparation-failed", "retry-setup"];
  if (run.kind === "uncertain") return ["delivery-unknown", "inspect"];
  return undefined;
}

function interruptedRun(run: Run): StopIncident["reason"] | undefined {
  if (run.kind === "creating") return "creation-unknown";
  if (run.kind === "preparing") return "preparation-interrupted";
  if (run.kind !== "running") return undefined;
  if ([run.delivery, run.review?.delivery].includes("sending"))
    return "delivery-unknown";
  if (run.review?.delivery === "creating") return "creation-unknown";
  return undefined;
}

function requireIncident(
  notice: StopIncident | undefined,
  expected: {
    id: string | undefined;
    owner: ThreadID | undefined;
    ticket: string;
    attempt: number;
    base: string;
  },
) {
  if (
    !notice ||
    notice.recovery !== "resume" ||
    !Object.entries(expected).every(
      ([key, value]) => notice[key as keyof StopIncident] === value,
    )
  )
    throw new Error("Resume requires the exact current stop incident");
}

/** Create the sequential dispatcher. Unknown remote effects are parked, never retried blindly. */
export function createFactory(
  root: string,
  host: NativeHost,
  openStore: (directory: string) => Bookkeeping,
  now: () => number = Date.now,
) {
  const directory = join(
    git(root, "rev-parse", "--absolute-git-dir"),
    "factory",
  );
  const watched = new Set<ThreadID>();
  let pending = Promise.resolve<unknown>(undefined);

  async function event(ticket: string, action: string, detail: string) {
    const persistence = openPersistence(directory, [], now);
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
    const pinned = runDefinition(run, config, directory);
    const dependencies = stateCache.runs;
    const insights = task.after.flatMap((id) => {
      const dependency = dependencies[id];
      return dependency?.kind === "done"
        ? [`${id}: ${dependency.insight} (${dependency.revision})`]
        : [];
    });
    return `Work only in your worktree ${run.worktree}. Ticket ${task.id}: ${task.brief}\nAllowed paths: ${pinned.scope.join(", ")}. Check: ${pinned.verify}.\nDefinition: ${run.definition ?? "legacy unpinned"}.\nDependency evidence: ${insights.join("; ") || "none"}.\n${run.feedback ? `Repair feedback: ${run.feedback}\n` : ""}Use a local commit for the change. Do not push, deploy, create tickets, edit factory files, or delegate.\nForeman: ${stateCache.owner}. Send questions and blockers there with send_thread_message, or the factory control action message-foreman with message text. Messaging does not grant factory control.\nAfter finishing, write JSON to ${join(directory, `${task.id}.report.json`)}: {"attempt":${run.attempt},"kind":"candidate","revision":"<full git HEAD>","insight":"<short verified finding>"}. If blocked, use {"attempt":${run.attempt},"kind":"blocked","reason":"<needed decision>"}. Report briefly here too.`;
  }

  let stateCache: State = { enabled: false, runs: {} };

  async function reconcile(
    action: "start" | "pause" | "reconcile" | "retry-setup" | "resume",
    owner?: ThreadID,
    observe: NativeHost["state"] = host.state,
    repairRequest?: { ticket: string; decision: string; incident: string },
    tools?: PluginTools,
  ) {
    await mkdir(directory, { recursive: true });
    const store = openStore(join(directory, "bookkeeping"));
    let persistence: ReturnType<typeof openPersistence> | undefined;
    let flushNotices = async () => {};
    try {
      await store.init();
      const config = await effectiveConfiguration(root);
      assertControlCaller(factoryStatus(directory), owner);
      const queue = tasks(JSON.parse(await readFile(config.tickets, "utf8")));
      persistence = openPersistence(directory, queue, now);
      const state = persistence.state;
      assertWatchdogCaller(state, action, owner, tools);
      restoreTickets(queue, persistence.tickets, state);
      let savedRuns = structuredClone(state.runs);
      function incident(
        ticket: string,
        run: Run,
        reason: StopIncident["reason"],
        recovery: StopIncident["recovery"],
      ) {
        if (!state.owner || run.incident?.reason === reason) return false;
        const source = checkpointIdentity(run) ??
          checkpointIdentity(savedRuns[ticket]) ?? {
            base: persistence!.lastEvent(ticket, "creating") ?? "unknown",
            attempt: 0,
          };
        run.incident = {
          id: randomUUID(),
          ticket,
          owner: state.owner,
          ...source,
          reason,
          recovery,
          delivery: "queued",
        };
        return true;
      }
      function commit(
        ticket: string,
        action: string,
        detail: string,
        reason?: StopIncident["reason"],
      ) {
        const run = state.runs[ticket];
        if (run && !run.incident) {
          const stop = stoppedRun(run, reason);
          if (stop) incident(ticket, run, ...stop);
        }
        if (run)
          run.watchdog = watchdogProgress(
            run,
            savedRuns[ticket]?.watchdog,
            action,
            now(),
          );
        try {
          persistence!.commit(state, ticket, action, detail);
        } catch (error) {
          // A failed transition must not be repersisted by notice recovery.
          flushNotices = async () => {};
          throw error;
        }
        savedRuns = structuredClone(state.runs);
      }
      controlState(
        state,
        action,
        config.execute,
        () => commit("factory", "paused", state.owner ?? ""),
        owner,
      );
      function parkedIncidents() {
        for (const [ticket, run] of Object.entries(state.runs)) {
          if (run.incident) continue;
          let stop = stoppedRun(run);
          const reason = interruptedRun(run);
          if (reason)
            stop = [
              reason,
              reason === "preparation-interrupted" ? "retry-setup" : "inspect",
            ];
          if (stop && incident(ticket, run, ...stop))
            commit(
              ticket,
              "stop-recorded",
              "Recovery requires Foreman diagnosis",
            );
        }
      }
      flushNotices = async () => {
        parkedIncidents();
        await installMonitoring();
        await reconcileWatchdog();
        await deliverAlerts(
          state,
          tools,
          now,
          () =>
            commit(
              "factory",
              "watchdog-delivery",
              "Reserved or acknowledged alert",
            ),
          config.execute,
        );
        for (const [ticket, run] of Object.entries(state.runs)) {
          const notice = run.incident;
          if (!notice || !state.owner) continue;
          if (notice.owner !== state.owner) {
            notice.owner = state.owner;
            notice.id = randomUUID();
            notice.delivery = "queued";
            delete notice.notifiedAt;
            commit(ticket, "notice-reassigned", notice.id);
          }
          if (notice.delivery !== "queued") continue;
          try {
            await host.send(
              notice.owner,
              `Factory stop ${notice.id}. Ticket ${ticket}, attempt ${notice.attempt}, base ${notice.base}. Reason: ${notice.reason}. Recovery: ${notice.recovery}. Read current factory status and private evidence before deciding. ${notice.recovery === "resume" ? `Only the owning Foreman may resume with ticket ${ticket}, incident ${notice.id}, and a diagnosis decision. A paused factory stays paused.` : "Inspect and resolve this stop; this notice does not authorize resume or grant permission."}`,
            );
            notice.delivery = "sent";
            notice.notifiedAt = now();
            commit(ticket, "notice-sent", notice.id);
          } catch (error) {
            notice.delivery = "queued";
            persistence!.event(
              ticket,
              "notice-delivery-unknown",
              String(error),
            );
          }
        }
      };
      async function reconcileWatchdog() {
        if (!state.enabled || !config.execute || !state.owner) return;
        for (const [ticket, run] of Object.entries(state.runs)) {
          if (run.kind === "done") continue;
          await reconcileRunWatchdog(ticket, run);
        }
      }
      async function reconcileRunWatchdog(ticket: string, run: Run) {
        if (!run.watchdog)
          commit(
            ticket,
            "watchdog-adopted",
            "Legacy timing starts at adoption",
          );
        const timing = run.watchdog!;
        const policy =
          runDefinition(run, config, directory).watchdog ?? defaultWatchdog;
        const at = now();
        const due = watchdogDue(timing, policy, at);
        if (due.spending) {
          timing.alerts.push({
            id: randomUUID(),
            kind: "spending",
            episode: timing.episode,
            attempt: timing.attempt,
            intendedAt: at,
          });
          commit(ticket, "spending-alert-intended", String(timing.attempt));
        }
        if (!due.nudge) return;
        if (
          !timing.alerts.some(
            (alert) =>
              alert.kind === "unresolved" && alert.episode === timing.episode,
          )
        ) {
          timing.alerts.push({
            id: randomUUID(),
            kind: "unresolved",
            episode: timing.episode,
            attempt: timing.attempt,
            intendedAt: at,
          });
          commit(ticket, "watchdog-alert-intended", timing.episode);
        }
        if (!tools) return;
        // Reserve before sending. An ambiguous delivery must not cause repeated nudges.
        timing.nudgedAt = at;
        commit(ticket, "watchdog-nudge-intended", timing.episode);
        try {
          await host.send(
            state.owner!,
            `Factory suspicion ${timing.episode}. Ticket ${ticket}, attempt ${timing.attempt}. No lifecycle progress for the suspicion interval. Diagnose current status and private evidence. Running or unknown activity retains its worker; this nudge does not authorize a duplicate or replacement worker, resume, or permission changes. User-alert delivery is reconciled from durable intent through the connected owner only.`,
          );
          persistence!.event(ticket, "watchdog-nudge-sent", timing.episode);
        } catch (error) {
          persistence!.event(
            ticket,
            "watchdog-nudge-delivery-unknown",
            String(error),
          );
        }
      }
      async function installMonitoring(startAdmission = false) {
        try {
          await reconcileSchedule(
            root,
            directory,
            state,
            queue,
            tools,
            () => {
              // The confirmed receipt and first owner claim land in the same SQLite commit.
              if (startAdmission && state.monitor!.schedule === "installed")
                state.owner ??= owner;
              commit("factory", "watchdog-schedule", state.monitor!.schedule);
            },
            config.execute,
            owner,
          );
          if (startAdmission) state.owner ??= owner;
        } catch (error) {
          if (!(error instanceof WatchdogUnavailable)) {
            flushNotices = async () => {};
            throw error;
          }
          state.monitor!.problem = error.message;
          if (startAdmission) {
            state.enabled = false;
            commit(
              "factory",
              "watchdog-installation-failed",
              "Execution not monitored or started",
            );
            flushNotices = async () => {};
            throw error;
          }
          commit("factory", "watchdog-unconfirmed", error.message);
          // Withhold watchdog effects, not incident recovery or queued stop notices.
          tools = undefined;
        }
      }
      stateCache = state;
      await installMonitoring(action === "start");
      async function adoptLegacyCheckpoints() {
        for (const task of queue) {
          const run = state.runs[task.id];
          if (run?.kind === "blocked" && !run.repair && !run.checkpoint) {
            try {
              const checkpoint = await repairCheckpoint(task, run);
              if (checkpoint.attempt === 2) run.repair = checkpoint;
              else run.checkpoint = checkpoint;
              delete run.incident;
            } catch {
              // Missing legacy evidence permits diagnosis only, never inferred repair.
            }
          }
        }
      }
      await adoptLegacyCheckpoints();
      parkedIncidents();
      function acceptInitialDefinition() {
        if (
          !state.enabled ||
          action === "retry-setup" ||
          factoryDefinition(directory)
        )
          return;
        persistence!.definition(definitionPin(config), true);
      }
      acceptInitialDefinition();
      async function preflightCheckpoint(
        task: Task,
        blocked: Extract<Run, { kind: "blocked" }>,
        preflight: Record<string, unknown>,
      ): Promise<Extract<Run, { kind: "running" }>> {
        if (!blocked.thread) throw new Error("No resumable worker checkpoint");
        const base = text(persistence!.lastEvent(task.id, "creating"));
        const worktree = join(directory, "worktrees", task.id);
        if (
          preflight.reason !== blocked.reason ||
          ["created", "sending", "sent"].some(
            (action) =>
              persistence!.lastEvent(task.id, action) !== blocked.thread,
          ) ||
          ["rejected", "repair-resumed", "review-created"].some(
            (action) => persistence!.lastEvent(task.id, action) !== undefined,
          ) ||
          git(worktree, "rev-parse", "HEAD") !== base
        )
          throw new Error("Missing pre-upgrade preflight evidence");
        return {
          kind: "running",
          thread: blocked.thread,
          worktree,
          base,
          attempt: 1,
          delivery: "sent",
          workerModel: config.workerModel,
          requirements: `${task.brief}\n${config.instructions}`,
        };
      }
      async function legacyRepairCheckpoint(
        task: Task,
        blocked: Extract<Run, { kind: "blocked" }>,
      ): Promise<Extract<Run, { kind: "running" }>> {
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
          requirements: `${task.brief}\n${config.instructions}`,
        };
      }
      async function repairCheckpoint(
        task: Task,
        blocked: Extract<Run, { kind: "blocked" }>,
      ) {
        const saved = blocked.repair ?? blocked.checkpoint;
        if (saved) return saved;
        const preflight = await currentReport(directory, task, 1);
        return preflight?.kind === "blocked"
          ? preflightCheckpoint(task, blocked, preflight)
          : legacyRepairCheckpoint(task, blocked);
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
        const request = repairRequest ?? {
          ticket: "",
          decision: "",
          incident: "",
        };
        const ticket = text(request.ticket);
        const decision = text(request.decision);
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
        requireIncident(blocked.incident, {
          id: request.incident,
          owner,
          ticket,
          attempt: repair.attempt,
          base: repair.base,
        });
        await verifyRepair(repair);
        state.runs[ticket] = {
          ...repair,
          incident: undefined,
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
      if (!state.enabled || !config.execute || !state.owner) return state;
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
        if (run.feedback) await verifyRepair(run);
        run.delivery = "sending";
        commit(task.id, "sending", run.thread);
        await host.send(run.thread, message);
        run.delivery = "sent";
        delete run.feedback;
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
          !allowedChanges(
            run.worktree,
            run.base,
            revision,
            runDefinition(run, config, directory).scope,
          ) ||
          (target !== run.base && target !== revision)
        ) {
          state.runs[task.id] = {
            kind: "blocked",
            definition: run.definition,
            thread: run.thread,
            reason: "Integration target changed; reconcile before landing",
          };
          commit(task.id, "blocked", "target-changed", "target-changed");
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
          definition: run.definition,
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
            runDefinition(run, config, directory).review &&
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
            definition: run.definition,
            thread: run.thread,
            reason: `Verification rejected attempt ${run.attempt}; Foreman escalation required: ${evidence}`,
            repair: run,
          };
          commit(task.id, "escalated", evidence, "verification-rejected");
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
        const message = reviewPrompt(
          review,
          run.definition
            ? `${run.requirements}\n${runDefinition(run, config, directory).instructions}`
            : run.requirements!,
        );
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
            definition: run.definition,
            thread: run.thread,
            reason: "Integration target changed; reconcile before landing",
          };
          commit(task.id, "blocked", "target-changed", "target-changed");
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
          command: runDefinition(run, config, directory).verify,
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

      async function reviewIdle(
        task: Task,
        run: Extract<Run, { kind: "running" }>,
      ) {
        const activity = await observe(run.review!.thread!);
        if (activity === "error" || activity === "awaiting-approval") {
          const created = incident(
            task.id,
            run,
            activityReasons[activity],
            "inspect",
          );
          if (created) commit(task.id, "review-stopped", activity);
        } else if (activity !== "unknown" && run.incident) {
          delete run.incident;
          commit(task.id, "review-recovered", activity);
        }
        return activity === "idle";
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
            definition: run.definition,
            thread: run.thread,
            reason:
              "Reviewed candidate or integration base changed; revalidate before landing",
          };
          commit(
            task.id,
            "blocked",
            "review-identity-changed",
            "review-identity-changed",
          );
          return;
        }
        if (!(await reviewIdle(task, run))) return;
        const verdict = await reviewVerdict(review);
        if (!verdict) return;
        review.evidence = verdict.evidence;
        commit(task.id, "review-verdict", verdict.evidence);
        if (verdict.kind === "issues")
          return reject(task, run, verdict.evidence);
        const report = await currentReport(directory, task, run.attempt);
        if (
          !report ||
          candidate(
            run,
            report,
            runDefinition(run, config, directory).scope,
          ) !== review.revision
        )
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
            definition: run.definition,
            incident: run.incident,
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
            definition: run.definition,
            thread: run.thread,
            reason: `Worker ${activity}; inspect before resuming`,
            checkpoint: run,
          };
          commit(task.id, "blocked", activity, activityReasons[activity]);
          return;
        }
        const report = await currentReport(directory, task, run.attempt);
        if (!report) return;
        if (report.kind === "blocked") {
          state.runs[task.id] = {
            kind: "blocked",
            definition: run.definition,
            thread: run.thread,
            reason: text(report.reason),
            checkpoint: run,
          };
          commit(task.id, "blocked", text(report.reason));
          return;
        }
        if (report.kind !== "candidate")
          throw new Error("Invalid worker report");
        return checkCandidate(task, run, report);
      }

      async function createWorker(task: Task, base: string, worktree: string) {
        const definition = state.runs[task.id]?.definition ?? config.digest;
        const pinned = factoryDefinition(directory, definition)!;
        if (state.runs[task.id]?.kind !== "creating") {
          state.runs[task.id] = {
            kind: "creating",
            base,
            worktree,
            definition,
          };
          commit(task.id, "creating", base);
        }
        const thread = await host.create(
          state.owner!,
          pinned.workerModel,
          pinned.workerEffort,
        );
        const run: Extract<Run, { kind: "running" }> = {
          kind: "running",
          definition,
          base,
          worktree,
          thread,
          attempt: 1,
          delivery: "queued",
          workerModel: pinned.workerModel,
          requirements: task.brief,
        };
        state.runs[task.id] = run;
        commit(task.id, "created", thread);
        await watch(thread);
        await send(task, run, await prompt(task, run, config));
        return state;
      }

      async function prepare(
        task: Task,
        base: string,
        worktree: string,
        preparationConfig = config,
      ) {
        if (!preparationConfig.setup)
          throw new Error("Configure setup before retrying preparation");
        persistence!.definition(definitionPin(preparationConfig));
        const run: Extract<Run, { kind: "preparing" }> = {
          kind: "preparing",
          definition: preparationConfig.digest,
          base,
          worktree,
          command: preparationConfig.setup.command,
          timeoutMs: preparationConfig.setup.timeoutMs,
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
        state.runs[next.id] = {
          kind: "creating",
          base,
          worktree,
          definition: config.digest,
        };
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
          return prepare(task, base, run.worktree, await configuration(root));
        }
        throw new Error("No preparation to retry");
      }
      if (!(await settleRuns())) await dispatchNext();
      return state;
    } finally {
      try {
        await flushNotices();
      } finally {
        persistence?.close();
        await store.close();
      }
    }
  }

  /** Serialize local callbacks; the poteto lock excludes other plugin processes. @throws On unsafe state or failed I/O. */
  function tick(
    action:
      | "status"
      | "start"
      | "pause"
      | "reconcile"
      | "retry-setup"
      | "resume"
      | "reload",
    owner?: ThreadID,
    observe: NativeHost["state"] = host.state,
    repairRequest?: Parameters<typeof reconcile>[3],
    tools?: PluginTools,
  ): Promise<State> {
    const result = pending
      .catch(() => {})
      .then(async () => {
        const initial = factoryStatus(directory);
        if (action !== "status") assertControlCaller(initial, owner);
        assertWatchdogCaller(initial, action, owner, tools);
        if (action === "reload") {
          assertControlCaller(factoryStatus(directory), owner);
          await configuration(root);
          const store = openStore(join(directory, "bookkeeping"));
          try {
            await store.init();
            const next = await configuration(root);
            assertControlCaller(factoryStatus(directory), owner);
            const persistence = openPersistence(directory, [], now);
            try {
              assertWatchdogCaller(persistence.state, action, owner, tools);
              persistence.definition(definitionPin(next), true);
              persistence.event("factory", "reloaded", next.digest);
              if (tools) {
                const queue = tasks(
                  JSON.parse(await readFile(next.tickets, "utf8")),
                );
                restoreTickets(queue, persistence.tickets, persistence.state);
                await reconcileSchedule(
                  root,
                  directory,
                  persistence.state,
                  queue,
                  tools,
                  () =>
                    persistence.commit(
                      persistence.state,
                      "factory",
                      "watchdog-schedule",
                      persistence.state.monitor!.schedule,
                    ),
                  next.execute,
                ).catch((error: unknown) => {
                  if (!(error instanceof WatchdogUnavailable)) throw error;
                  persistence.state.monitor!.problem = error.message;
                  persistence.commit(
                    persistence.state,
                    "factory",
                    "watchdog-unconfirmed",
                    error.message,
                  );
                });
              }
              return persistence.state;
            } finally {
              persistence.close();
            }
          } finally {
            await store.close();
          }
        }
        if (action === "status") {
          await configuration(root);
          return factoryStatus(directory);
        }
        await configuration(root);
        if (!retryAdmission(initial, action)) return initial;
        return reconcile(action, owner, observe, repairRequest, tools);
      });
    pending = result;
    return result;
  }
  return { tick, directory };
}
