import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { factoryRecords, type Run } from "./persistence";

export type DashboardSnapshot = {
  project: string;
  observedAt: string;
  enabled: boolean;
  tasks: {
    id: string;
    title: string;
    status: "working" | "idle" | "blocked" | "queued" | "accepted" | "unknown";
    thread: string | null;
    revision: string | null;
  }[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid status");
  return { ...value };
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid task");
  return value;
}

function reference(value: unknown, pattern: RegExp): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Invalid task");
  return value;
}

function activity(
  value: unknown,
): DashboardSnapshot["tasks"][number]["status"] {
  switch (value) {
    case "working":
    case "idle":
    case "blocked":
    case "queued":
    case "accepted":
    case "unknown":
      return value;
    default:
      throw new Error("Invalid activity");
  }
}

function parseTask(value: unknown): DashboardSnapshot["tasks"][number] {
  const task = record(value);
  return {
    id: string(task.id),
    title: string(task.title),
    status: activity(task.status),
    thread: reference(task.thread, /^T-[\w-]+$/),
    revision: reference(task.revision, /^[a-f0-9]{40}$/),
  };
}

function parseSnapshot(input: unknown): DashboardSnapshot {
  const value = record(input);
  if (
    typeof value.project !== "string" ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.tasks)
  )
    throw new Error("Invalid status");
  return {
    project: value.project,
    observedAt: value.observedAt,
    enabled: value.enabled,
    tasks: value.tasks.map(parseTask),
  };
}

function errorCode(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return error.code;
}

function reviewFor(id: string, run: Run | undefined) {
  if (!run || !("review" in run)) return null;
  const review = run.review;
  if (!review || review.ticket !== id) return null;
  const matches =
    run.kind === "done"
      ? review.revision === run.revision
      : review.attempt === run.attempt && review.base === run.base;
  return matches ? review : null;
}

function durableTask(id: string, run: Run | undefined) {
  const row: DashboardSnapshot["tasks"][number] = {
    id,
    title: id,
    status: "queued",
    thread: null,
    revision: null,
  };
  if (!run) return row;
  const statuses = {
    preparing: "unknown",
    "preparation-failed": "blocked",
    creating: "unknown",
    running: "unknown",
    blocked: "blocked",
    uncertain: "blocked",
    done: "accepted",
  } as const;
  row.status = statuses[run.kind];
  if ("thread" in run) row.thread = reference(run.thread ?? null, /^T-[\w-]+$/);
  if (run.kind === "done")
    row.revision = reference(run.revision, /^[a-f0-9]{40}$/);
  if (run.kind === "running" && run.delivery !== "sent") row.status = "blocked";
  return row;
}

function applyObservation(
  row: DashboardSnapshot["tasks"][number],
  observed: DashboardSnapshot["tasks"][number] | undefined,
  fresh: boolean,
  titleAllowed: boolean,
) {
  if (!observed) return;
  if (observed.thread !== row.thread || observed.revision !== row.revision)
    return;
  if (titleAllowed) row.title = observed.title;
  if (
    fresh &&
    row.status === "unknown" &&
    row.thread !== null &&
    new Set(["working", "idle", "blocked"]).has(observed.status)
  )
    row.status = observed.status;
}

function projectTask(
  id: string,
  run: Run | undefined,
  observed: DashboardSnapshot["tasks"][number] | undefined,
  fresh: boolean,
) {
  const row = durableTask(id, run);
  const review = reviewFor(id, run);
  let gate = null;
  let reviewEvidence = null;
  if (review) {
    const revision = reference(review.revision, /^[a-f0-9]{40}$/);
    const base = reference(review.base, /^[a-f0-9]{40}$/);
    row.title = `${id} - post-graft review (${review.delivery})`;
    row.thread = reference(review.thread ?? null, /^T-[\w-]+$/);
    row.revision = revision;
    if (row.status === "unknown" && review.delivery !== "sent")
      row.status = "blocked";
    gate = { revision, base, stage: review.stage };
    reviewEvidence = {
      ...gate,
      attempt: review.attempt,
      pending: run?.kind !== "done",
      thread: row.thread,
    };
  }
  applyObservation(row, observed, fresh, !review);
  return {
    ...row,
    evidence: {
      acceptance: run?.kind === "done" ? { revision: row.revision } : null,
      gate,
      review: reviewEvidence,
    },
  };
}

async function readObservation(directory: string) {
  try {
    const snapshot = parseSnapshot(
      JSON.parse(
        await readFile(join(directory, "factory/dashboard.json"), "utf8"),
      ),
    );
    const age = Date.now() - Date.parse(snapshot.observedAt);
    return {
      snapshot,
      observations: "available",
      fresh: age >= -5000 && age < 20_000,
    };
  } catch (error) {
    return {
      snapshot: null,
      observations: errorCode(error) === "ENOENT" ? "missing" : "invalid",
      fresh: false,
    };
  }
}

/** Serve a curated, read-only status projection, never raw factory files. @throws If Git or HTML is unavailable. */
export function startDashboard({ root, port }: { root: string; port: number }) {
  const directory = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).trim();
  const html = readFileSync(join(import.meta.dir, "dashboard.html"), "utf8");
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      if (request.method !== "GET")
        return new Response("Read-only service", {
          status: 405,
          headers: { ...headers, allow: "GET" },
        });
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(html, {
          headers: { ...headers, "content-type": "text/html; charset=utf-8" },
        });
      if (path !== "/api/status")
        return new Response("Not found", { status: 404, headers });
      const { snapshot, observations, fresh } =
        await readObservation(directory);
      const empty = {
        project: basename(root),
        observedAt: snapshot?.observedAt ?? null,
        observations,
        enabled: false,
        fresh: false,
        tasks: [],
      };
      try {
        const records = factoryRecords(join(directory, "factory"));
        if (!records)
          return Response.json({ ...empty, durable: "missing" }, { headers });
        const { state, tickets } = records;
        const observed = new Map(
          snapshot?.tasks.map((task) => [task.id, task]),
        );
        return Response.json(
          {
            ...empty,
            durable: "available",
            enabled: state.enabled,
            fresh,
            tasks: [...new Set([...tickets, ...Object.keys(state.runs)])].map(
              (id) =>
                projectTask(
                  id,
                  Object.hasOwn(state.runs, id) ? state.runs[id] : undefined,
                  observed.get(id),
                  fresh,
                ),
            ),
          },
          { headers },
        );
      } catch (error) {
        const busy = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]).has(
          String(errorCode(error)),
        );
        return Response.json(
          {
            ...empty,
            durable: busy ? "unavailable" : "invalid",
            error: "Durable status unavailable.",
          },
          { status: 503, headers },
        );
      }
    },
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { repo: { type: "string", default: "." } },
  });
  const server = startDashboard({
    root: resolve(values.repo ?? "."),
    port: Number(process.env.PORT ?? 4310),
  });
  process.stdout.write(`Factory dashboard listening on port ${server.port}\n`);
}
