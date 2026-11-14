import { Database } from "bun:sqlite";
import type { AgentReasoningEffort } from "@ampcode/plugin";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validReview, type Review } from "./review";

export type ThreadID = `T-${string}`;
export type Task = {
  id: string;
  brief: string;
  after: string[];
  steps?: string[];
  size?: "small" | "medium" | "large";
  risky?: boolean;
};
type Preparation = {
  base: string;
  worktree: string;
  command: string;
  timeoutMs: number;
  log: string;
  pid?: number;
};
export type DefinitionPin = {
  digest: string;
  scope: string[];
  verify: string;
  review: boolean;
  workerModel: `${string}/${string}`;
  workerEffort?: AgentReasoningEffort;
  instructions: string;
  tickets: string;
  setup?: { command: string; timeoutMs: number };
};
export type StopIncident = {
  id: string;
  ticket: string;
  owner: ThreadID;
  base: string;
  attempt: number;
  reason:
    | "verification-rejected"
    | "worker-blocked"
    | "worker-error"
    | "approval-required"
    | "preparation-failed"
    | "preparation-interrupted"
    | "delivery-unknown"
    | "creation-unknown"
    | "target-changed"
    | "review-identity-changed";
  recovery: "resume" | "retry-setup" | "inspect";
  delivery: "queued" | "sent";
};
export type Run = (
  | (Preparation & { kind: "preparing" })
  | (Preparation & { kind: "preparation-failed"; reason: string })
  | { kind: "creating"; base: string; worktree: string }
  | {
      kind: "running";
      base: string;
      worktree: string;
      thread: ThreadID;
      attempt: number;
      delivery: "queued" | "sending" | "sent";
      review?: Review;
      workerModel?: string;
      requirements?: string;
      feedback?: string;
    }
  | {
      kind: "blocked";
      reason: string;
      thread?: ThreadID;
      repair?: Extract<Run, { kind: "running" }>;
      checkpoint?: Extract<Run, { kind: "running" }>;
    }
  | { kind: "uncertain"; reason: string; thread: ThreadID }
  | {
      kind: "done";
      revision: string;
      thread: ThreadID;
      insight: string;
      review?: Review;
    }
) & { definition?: string; incident?: StopIncident };
export type State = {
  enabled: boolean;
  owner?: ThreadID;
  runs: Record<string, Run>;
};
type Event = { at: string; ticket: string; action: string; detail: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid factory record");
  return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Parse ordered authored labels; missing legacy labels become empty. @throws On malformed labels. */
export function taskSteps(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(text))
    throw new Error("Invalid ticket steps; expected nonblank string labels");
  return value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function thread(value: unknown): value is ThreadID {
  return text(value) && value.startsWith("T-") && value.length > 2;
}

function worktreeRun(run: Record<string, unknown>): boolean {
  return text(run.base) && text(run.worktree);
}

function preparationRun(run: Record<string, unknown>): boolean {
  return (
    worktreeRun(run) &&
    ["command", "log"].every((key) => text(run[key])) &&
    positiveInteger(run.timeoutMs) &&
    run.timeoutMs <= 2_147_483_647 &&
    (run.pid === undefined || positiveInteger(run.pid)) &&
    ["thread", "attempt"].every((key) => run[key] === undefined)
  );
}

function reviewFields(run: Record<string, unknown>): boolean {
  return (
    ["workerModel", "requirements", "feedback"].every(
      (key) => run[key] === undefined || text(run[key]),
    ) &&
    (run.review === undefined || validReview(run.review))
  );
}

const runValidators: Record<string, (run: Record<string, unknown>) => boolean> =
  {
    preparing: preparationRun,
    "preparation-failed": (run) => preparationRun(run) && text(run.reason),
    creating: worktreeRun,
    running: (run) =>
      worktreeRun(run) &&
      thread(run.thread) &&
      positiveInteger(run.attempt) &&
      typeof run.delivery === "string" &&
      ["queued", "sending", "sent"].includes(run.delivery) &&
      reviewFields(run),
    blocked: (run) =>
      text(run.reason) &&
      (run.thread === undefined || thread(run.thread)) &&
      (run.checkpoint === undefined ||
        (run.repair === undefined &&
          validRepair(run.checkpoint, run.thread))) &&
      (run.repair === undefined ||
        (validRepair(run.repair, run.thread) && run.repair.attempt % 2 === 0)),
    uncertain: (run) => text(run.reason) && thread(run.thread),
    done: (run) =>
      text(run.revision) &&
      thread(run.thread) &&
      typeof run.insight === "string" &&
      reviewFields(run),
  };

function validRepair(
  value: unknown,
  originalThread: unknown,
): value is Extract<Run, { kind: "running" }> {
  const run = record(value);
  return (
    run.kind === "running" &&
    runValidators.running!(run) &&
    run.thread === originalThread &&
    Number.isSafeInteger(Number(run.attempt) + 1) &&
    run.delivery === "sent" &&
    run.review === undefined &&
    (run.definition === undefined || validDigest(run.definition))
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function definitionFields(value: unknown) {
  const pin = record(value);
  const patterns = [
    [pin.digest, /^[a-f0-9]{64}$/],
    [pin.workerModel, /^[^/]+\/.+$/],
    [pin.verify, /\S/],
    [pin.tickets, /\S/],
  ] as const;
  return (
    patterns.every(
      ([value, pattern]) => typeof value === "string" && pattern.test(value),
    ) &&
    Array.isArray(pin.scope) &&
    pin.scope.length > 0 &&
    pin.scope.every(text) &&
    typeof pin.review === "boolean" &&
    typeof pin.instructions === "string" &&
    new Set<unknown>([
      undefined,
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]).has(pin.workerEffort)
  );
}

function validateIncident(id: string, value: unknown) {
  if (value === undefined) return;
  const incident = record(value);
  const enums = {
    delivery: ["queued", "sent"],
    recovery: ["resume", "retry-setup", "inspect"],
    reason: [
      "verification-rejected",
      "worker-blocked",
      "worker-error",
      "approval-required",
      "preparation-failed",
      "preparation-interrupted",
      "delivery-unknown",
      "creation-unknown",
      "target-changed",
      "review-identity-changed",
    ],
  };
  const valid =
    [incident.id, incident.base].every(text) &&
    incident.ticket === id &&
    thread(incident.owner) &&
    Number.isSafeInteger(incident.attempt) &&
    Number(incident.attempt) >= 0 &&
    Object.entries(enums).every(([key, values]) =>
      values.includes(String(incident[key])),
    );
  if (!valid) throw new Error(`Invalid factory incident ${id}`);
}

function validateRun(id: string, value: unknown) {
  const run = record(value);
  validateIncident(id, run.incident);
  if (run.definition !== undefined && !validDigest(run.definition))
    throw new Error(`Invalid definition pin ${id}`);
  const validate =
    typeof run.kind === "string" && Object.hasOwn(runValidators, run.kind)
      ? runValidators[run.kind]
      : undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !validate?.(run))
    throw new Error(`Invalid factory run ${id}`);
}

function stateRecord(value: unknown): State {
  const state = record(value);
  if (
    typeof state.enabled !== "boolean" ||
    (state.owner !== undefined && !thread(state.owner))
  )
    throw new Error("Invalid factory state");
  for (const [id, value] of Object.entries(record(state.runs)))
    validateRun(id, value);
  return value as State;
}

function legacy(directory: string) {
  const statePath = join(directory, "state.json");
  const eventsPath = join(directory, "events.jsonl");
  const state = stateRecord(
    existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : { enabled: false, runs: {} },
  );
  const lines = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split("\n")
    : [];
  if (lines.at(-1) === "") lines.pop();
  const events = lines.map((line) => {
    const event = record(JSON.parse(line));
    if (
      !text(event.at) ||
      !Number.isFinite(Date.parse(event.at)) ||
      !text(event.ticket) ||
      !text(event.action) ||
      typeof event.detail !== "string"
    )
      throw new Error("Invalid factory event");
    return event as Event;
  });
  return { state, events };
}

function database(directory: string, readonly: boolean) {
  const db = new Database(join(directory, "state.sqlite"), {
    readonly,
    strict: true,
  });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const version = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!.user_version;
    if (version !== 1 && version !== 2)
      throw new Error(`Unsupported factory schema version ${version}`);
    const integrity = db
      .query<{ quick_check: string }, []>("PRAGMA quick_check")
      .all();
    if (integrity.length !== 1 || integrity[0]!.quick_check !== "ok")
      throw new Error("Corrupt factory database");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readState(db: Database): State {
  const coordinator = db
    .query<{ enabled: number; owner: ThreadID | null }, []>(
      "SELECT enabled, owner FROM coordinator WHERE id = 1",
    )
    .get();
  if (!coordinator || ![0, 1].includes(coordinator.enabled))
    throw new Error("Invalid factory coordinator");
  const runs = Object.fromEntries(
    db
      .query<{ ticket: string; data: string }, []>(
        "SELECT ticket, data FROM runs",
      )
      .all()
      .map((row) => [row.ticket, JSON.parse(row.data)]),
  );
  return stateRecord({
    enabled: coordinator.enabled === 1,
    ...(coordinator.owner === null ? {} : { owner: coordinator.owner }),
    runs,
  });
}

function saveState(db: Database, state: State) {
  db.query(
    "INSERT OR REPLACE INTO coordinator (id, enabled, owner) VALUES (1, ?, ?)",
  ).run(Number(state.enabled), state.owner ?? null);
  db.run("DELETE FROM runs");
  const insert = db.query("INSERT INTO runs (ticket, data) VALUES (?, ?)");
  for (const [id, run] of Object.entries(state.runs))
    insert.run(id, JSON.stringify(run));
}

function saveEvent(db: Database, event: Event) {
  db.query(
    "INSERT INTO events (at, ticket, action, detail) VALUES (?, ?, ?, ?)",
  ).run(event.at, event.ticket, event.action, event.detail);
}

function definitionTables(db: Database) {
  if (
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
      .user_version === 2
  )
    return;
  db.run(`
    CREATE TABLE IF NOT EXISTS definitions (digest TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loaded_definition (id INTEGER PRIMARY KEY CHECK (id = 1), digest TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
}

/** Read an immutable pin or the accepted factory definition without writing storage. @throws On corrupt or missing referenced definitions. */
export function factoryDefinition(
  directory: string,
  digest?: string,
): DefinitionPin | undefined {
  if (!existsSync(join(directory, "state.sqlite"))) return undefined;
  const db = database(directory, true);
  try {
    if (
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
        .user_version === 1
    )
      return undefined;
    const row =
      digest === undefined
        ? db
            .query<{ data: string }, []>(
              "SELECT data FROM definitions JOIN loaded_definition USING (digest) WHERE id = 1",
            )
            .get()
        : db
            .query<{ data: string }, [string]>(
              "SELECT data FROM definitions WHERE digest = ?",
            )
            .get(digest);
    if (!row) {
      if (digest !== undefined) throw new Error("Missing pinned definition");
      return undefined;
    }
    const pin: unknown = JSON.parse(row.data);
    if (!definitionFields(pin)) throw new Error("Invalid stored definition");
    return pin as DefinitionPin;
  } finally {
    db.close();
  }
}

/** Read durable or validated legacy state without creating runtime files. @throws On invalid storage. */
export function factoryStatus(directory: string): State {
  if (!existsSync(join(directory, "state.sqlite")))
    return legacy(directory).state;
  const db = database(directory, true);
  try {
    return db.transaction(() => readState(db))();
  } finally {
    db.close();
  }
}

/** Read curated SQLite tickets and state together; never import legacy files. @throws On invalid storage. */
export function factoryRecords(directory: string) {
  if (!existsSync(join(directory, "state.sqlite"))) return null;
  const db = database(directory, true);
  try {
    return db.transaction(() => {
      const state = readState(db);
      const tickets = db
        .query<{ id: string; data: string }, []>(
          "SELECT id, data FROM tickets ORDER BY rowid",
        )
        .all()
        .map(({ id, data }) => {
          if (!/^[a-zA-Z0-9_-]+$/.test(id))
            throw new Error("Invalid factory ticket identity");
          return { id, steps: taskSteps(record(JSON.parse(data)).steps) };
        });
      return { state, tickets };
    })();
  } finally {
    db.close();
  }
}

/** Open storage under the caller's poteto lock; migrate once. @throws On invalid storage or I/O. */
export function openPersistence(directory: string, queue: Task[]) {
  const imported = existsSync(join(directory, "state.sqlite"))
    ? null
    : legacy(directory);
  if (imported) mkdirSync(directory, { recursive: true });
  const db = imported
    ? new Database(join(directory, "state.sqlite"), {
        create: true,
        strict: true,
      })
    : database(directory, false);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const state = db.transaction(() => {
      if (imported) {
        db.run(`
          CREATE TABLE coordinator (id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), owner TEXT);
          CREATE TABLE tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE runs (ticket TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL,
            ticket TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
          PRAGMA user_version = 1;
        `);
        definitionTables(db);
        saveState(db, imported.state);
        for (const event of imported.events) saveEvent(db, event);
      }
      definitionTables(db);
      const state = readState(db);
      const upsert = db.query(
        "INSERT OR REPLACE INTO tickets (id, data) VALUES (?, ?)",
      );
      for (const task of queue) {
        const data = JSON.stringify(task);
        const previous = db
          .query<{ data: string }, [string]>(
            "SELECT data FROM tickets WHERE id = ?",
          )
          .get(task.id);
        if (previous?.data === data) continue;
        upsert.run(task.id, data);
        saveEvent(db, {
          at: new Date().toISOString(),
          ticket: task.id,
          action: "configured",
          detail: data,
        });
      }
      return state;
    })();
    return {
      state,
      /** Save a validated immutable definition, optionally accepting it for future dispatch. @throws On storage failure. */
      definition(pin: DefinitionPin, load = false) {
        db.transaction(() => {
          db.query(
            "INSERT OR IGNORE INTO definitions (digest, data) VALUES (?, ?)",
          ).run(pin.digest, JSON.stringify(pin));
          if (load)
            db.query(
              "INSERT OR REPLACE INTO loaded_definition (id, digest) VALUES (1, ?)",
            ).run(pin.digest);
        })();
      },
      tickets: db
        .query<{ data: string }, []>("SELECT data FROM tickets ORDER BY rowid")
        .all()
        .map((row) => {
          const task = JSON.parse(row.data) as Task;
          taskSteps(task.steps);
          return task;
        }),
      /** Read the latest durable event for explicit pre-upgrade recovery. @throws On storage failure. */
      lastEvent(ticket: string, action: string) {
        return db
          .query<{ detail: string }, [string, string]>(
            "SELECT detail FROM events WHERE ticket = ? AND action = ? ORDER BY id DESC LIMIT 1",
          )
          .get(ticket, action)?.detail;
      },
      /** Persist state and its event together. @throws On transaction failure; both roll back. */
      commit(state: State, ticket: string, action: string, detail: string) {
        db.transaction(() => {
          saveState(db, state);
          saveEvent(db, {
            at: new Date().toISOString(),
            ticket,
            action,
            detail,
          });
        })();
      },
      /** Append a diagnostic without inventing a state transition. @throws On I/O failure. */
      event(ticket: string, action: string, detail: string) {
        saveEvent(db, { at: new Date().toISOString(), ticket, action, detail });
      },
      /** Release the database before releasing the poteto lock. */
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
