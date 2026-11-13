import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validReview, type Review } from "./review";

export type ThreadID = `T-${string}`;
export type Task = {
  id: string;
  brief: string;
  after: string[];
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
export type Run =
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
    }
  | { kind: "blocked"; reason: string; thread?: ThreadID }
  | { kind: "uncertain"; reason: string; thread: ThreadID }
  | {
      kind: "done";
      revision: string;
      thread: ThreadID;
      insight: string;
      review?: Review;
    };
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
    ["workerModel", "requirements"].every(
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
      text(run.reason) && (run.thread === undefined || thread(run.thread)),
    uncertain: (run) => text(run.reason) && thread(run.thread),
    done: (run) =>
      text(run.revision) &&
      thread(run.thread) &&
      typeof run.insight === "string" &&
      reviewFields(run),
  };

function validateRun(id: string, value: unknown) {
  const run = record(value);
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
    if (version !== 1)
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

/** Read existing SQLite identity and state together; never import legacy files. @throws On invalid storage. */
export function factoryRecords(directory: string) {
  if (!existsSync(join(directory, "state.sqlite"))) return null;
  const db = database(directory, true);
  try {
    return db.transaction(() => {
      const state = readState(db);
      const tickets = db
        .query<{ id: string }, []>("SELECT id FROM tickets ORDER BY rowid")
        .all()
        .map(({ id }) => {
          if (!/^[a-zA-Z0-9_-]+$/.test(id))
            throw new Error("Invalid factory ticket identity");
          return id;
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
        saveState(db, imported.state);
        for (const event of imported.events) saveEvent(db, event);
      }
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
      tickets: db
        .query<{ data: string }, []>("SELECT data FROM tickets ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.data) as Task),
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
