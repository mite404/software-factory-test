import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { effectiveDefinition } from "./native";
import {
  factoryEvents,
  factoryRecords,
  lifecycleStatus,
  runCheckpoint,
  runStage,
  stages,
  taskSteps,
  type Task,
  type Run,
} from "./persistence";
import { pipelineSteps } from "./pipeline";

export type DashboardEvent = {
  id: number;
  at: string;
  ticket: string;
  action: string;
  attempt?: number;
  revision?: string;
  thread?: string;
};

const DETAIL_ACTIONS = new Set([
  "preparing",
  "setup-spawned",
  "repair-resumed",
  "review-creating",
  "review-created",
  "review-sending",
  "review-sent",
]);
const THREAD_ACTIONS = new Set([
  "created",
  "sending",
  "sent",
  "provider-continuation-intended",
  "provider-continuation-unknown",
  "provider-continuation-sent",
  "provider-recovered",
]);

function jsonDetail(detail: string): Record<string, unknown> {
  try {
    return record(JSON.parse(detail));
  } catch {
    return {};
  }
}

function eventDetail(action: string, detail: string): Record<string, unknown> {
  if (action === "accepted") return { revision: detail };
  if (THREAD_ACTIONS.has(action)) return { thread: detail };
  return DETAIL_ACTIONS.has(action) ? jsonDetail(detail) : {};
}

function matchingString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.exec(value)?.[0] === value
    ? value
    : undefined;
}

function publicEvent(
  row: NonNullable<ReturnType<typeof factoryEvents>>[number],
): DashboardEvent {
  const event: DashboardEvent = {
    id: row.id,
    at: row.at,
    ticket: row.ticket,
    action: row.action,
  };
  const detail = eventDetail(row.action, row.detail);
  if (
    typeof detail.attempt === "number" &&
    Number.isSafeInteger(detail.attempt) &&
    detail.attempt > 0
  )
    event.attempt = detail.attempt;
  event.revision = matchingString(detail.revision, /^[a-f0-9]{40}$/);
  event.thread = matchingString(detail.thread, /^T-[\w-]+$/);
  return event;
}

function eventBounds(url: URL) {
  const after = url.searchParams.get("after") ?? "0";
  const limit = url.searchParams.get("limit") ?? "100";
  if (
    !matchingString(after, /^\d+$/) ||
    !Number.isSafeInteger(Number(after)) ||
    !matchingString(limit, /^\d+$/) ||
    Number(limit) < 1 ||
    Number(limit) > 500
  )
    return null;
  return { after: Number(after), limit: Number(limit) };
}

function eventsResponse(
  directory: string,
  url: URL,
  headers: Record<string, string>,
) {
  const bounds = eventBounds(url);
  if (!bounds)
    return Response.json(
      { error: "Invalid event cursor or limit" },
      { status: 400, headers },
    );
  try {
    const rows = factoryEvents(
      join(directory, "factory"),
      bounds.after,
      bounds.limit,
    );
    return Response.json(
      {
        durable: rows ? "available" : "missing",
        events: rows?.map(publicEvent) ?? [],
      },
      { headers },
    );
  } catch (error) {
    const busy = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]).has(
      String(errorCode(error)),
    );
    return Response.json(
      {
        durable: busy ? "unavailable" : "invalid",
        events: [],
        error: "Durable status unavailable.",
      },
      { status: 503, headers },
    );
  }
}

export type DashboardSnapshot = {
  project: string;
  observedAt: string;
  enabled: boolean;
  tasks: {
    id: string;
    title: string;
    steps: string[];
    activity: "working" | "idle" | "blocked" | null;
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
  const matched = matchingString(value, pattern);
  if (!matched) throw new Error("Invalid task");
  return matched;
}

// Observations saved before activity existed carry none, so a missing value reads as unobserved.
function activity(
  value: unknown,
): DashboardSnapshot["tasks"][number]["activity"] {
  switch (value) {
    case undefined:
    case null:
      return null;
    case "working":
    case "idle":
    case "blocked":
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
    steps: taskSteps(task.steps),
    activity: activity(task.activity),
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

function matchingRejection(
  detail: Record<string, unknown>,
  review: Record<string, unknown> | undefined,
) {
  const thread = matchingString(review?.thread, /^T-[\w-]+$/);
  if (
    detail.kind !== "issues" ||
    !thread ||
    !review ||
    !["ticket", "attempt", "revision", "base", "stage"].every(
      (key) => detail[key] === review[key],
    ) ||
    !Number.isSafeInteger(detail.attempt) ||
    Number(detail.attempt) < 1
  )
    return null;
  return { attempt: Number(detail.attempt), thread };
}

function rejectedReviews(
  events: NonNullable<ReturnType<typeof factoryRecords>>["reviews"],
) {
  const reviews = new Map<string, Record<string, unknown>>();
  const rejected = new Map<
    string,
    Map<string, { attempt: number; thread: string }>
  >();
  for (const event of events) {
    const detail = jsonDetail(event.detail);
    if (event.action === "review-created") {
      reviews.set(event.ticket, detail);
      continue;
    }
    const rejection = matchingRejection(detail, reviews.get(event.ticket));
    if (!rejection) continue;
    const rows = rejected.get(event.ticket) ?? new Map();
    rows.set(`${rejection.attempt}/${rejection.thread}`, rejection);
    rejected.set(event.ticket, rows);
  }
  return new Map(
    [...rejected].map(([ticket, rows]) => [ticket, [...rows.values()]]),
  );
}

function durableTask(id: string, steps: string[], run: Run | undefined) {
  const row: DashboardSnapshot["tasks"][number] = {
    id,
    title: id,
    steps,
    activity: null,
    thread: null,
    revision: null,
  };
  if (!run) return row;
  if ("thread" in run) row.thread = reference(run.thread ?? null, /^T-[\w-]+$/);
  if (run.kind === "done")
    row.revision = reference(run.revision, /^[a-f0-9]{40}$/);
  if (run.kind === "running" && run.delivery !== "sent")
    row.activity = "blocked";
  return row;
}

function applyObservation(
  row: DashboardSnapshot["tasks"][number],
  observed: DashboardSnapshot["tasks"][number] | undefined,
  fresh: boolean,
  open: boolean,
) {
  if (!observed) return;
  if (observed.thread !== row.thread || observed.revision !== row.revision)
    return;
  if (fresh && open && row.activity === null && row.thread !== null)
    row.activity = observed.activity;
}

function attemptOf(run: Run | undefined): number | null {
  return run && "attempt" in run ? (run.attempt ?? null) : null;
}

function githubRepository(root: string): string | null {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const branch = git("branch", "--show-current");
    const remote = git("config", "--get", `branch.${branch}.remote`);
    const url = git("remote", "get-url", remote);
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
        url,
      );
    return match && ![".", ".."].includes(match[2]!)
      ? `${match[1]}/${match[2]}`
      : null;
  } catch {
    return null;
  }
}

function projectMerge(run: Run | undefined, repository: string | null) {
  if (run?.kind !== "done" || !run.merge) return null;
  return {
    pr: run.merge.pr,
    url: repository
      ? `https://github.com/${repository}/pull/${run.merge.pr}`
      : null,
    commit: run.merge.commit,
    at: run.merge.at,
  };
}

function projectStop(incident: Run["incident"]) {
  if (!incident) return null;
  return {
    reason: incident.reason,
    role: incident.cause?.role ?? null,
    thread: reference(incident.cause?.thread ?? null, /^T-[\w-]+$/),
  };
}

function projectRunLinks(id: string, run: Run | undefined) {
  const checkpoint = runCheckpoint(run);
  const review = reviewFor(id, checkpoint);
  return {
    reviewerThread: reference(review?.thread ?? null, /^T-[\w-]+$/),
    stop: projectStop(run?.incident),
    parked: runStage(run).stage === "parked",
    // The owning worker's attempt; a repair after rejection raises it.
    attempt: attemptOf(checkpoint),
  };
}

function iso(at: number | null | undefined) {
  return typeof at === "number" ? new Date(at).toISOString() : null;
}

// Curated at acceptance; the raw report insight never leaves storage.
function projectAcceptance(run: Run | undefined) {
  return run?.kind === "done"
    ? { acceptedAt: iso(run.acceptedAt), summary: run.summary ?? null }
    : { acceptedAt: null, summary: null };
}

// Only the stage's own curated fields: no reasons, briefs, report paths or thread content. The
// kind and stop name are keys of the declared table, so the page can place a run on its drawing.
function projectStage(run: Run | undefined, intake: Task["intake"]) {
  const { stage, actor, step, kind, stopName, since, clearsAt } = runStage(
    run,
    intake,
  );
  const work = runCheckpoint(run);
  return {
    stage,
    actor,
    stageSince: iso(since),
    step: step ? pipelineSteps.findIndex((entry) => entry.id === step) : null,
    kind,
    stopName,
    rejectedBy: work && "rejectedBy" in work ? (work.rejectedBy ?? null) : null,
    clearsAt: iso(clearsAt),
    ...projectAcceptance(run),
  };
}

function projectTask(
  id: string,
  steps: string[],
  run: Run | undefined,
  intake: Task["intake"],
  observed: DashboardSnapshot["tasks"][number] | undefined,
  fresh: boolean,
  repository: string | null,
) {
  const row = durableTask(id, steps, run);
  const review = reviewFor(id, run);
  const workerThread = row.thread;
  // The declared status of the run's stage; only runs still in flight take a live activity.
  const declared = runStage(run, intake).status;
  const open = declared === "unknown";
  const pending = declared !== "accepted";
  let gate = null;
  let reviewEvidence = null;
  if (review) {
    const revision = reference(review.revision, /^[a-f0-9]{40}$/);
    const base = reference(review.base, /^[a-f0-9]{40}$/);
    const thread = reference(review.thread ?? null, /^T-[\w-]+$/);
    if (pending) {
      row.title = `${id} - post-graft review (${review.delivery})`;
      row.thread = thread;
    }
    row.revision = revision;
    if (open && review.delivery !== "sent") row.activity = "blocked";
    gate = { revision, base, stage: review.stage };
    reviewEvidence = {
      ...gate,
      attempt: review.attempt,
      pending,
      thread,
    };
  }
  applyObservation(row, observed, fresh, open);
  return {
    ...row,
    workerThread,
    ...projectStage(run, intake),
    ...projectRunLinks(id, run),
    merge: projectMerge(run, repository),
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

function targetBranch(root: string) {
  return (
    execFileSync("git", ["-C", root, "branch", "--show-current"], {
      encoding: "utf8",
    }).trim() || "detached HEAD"
  );
}

async function definitionResponse(
  root: string,
  headers: Record<string, string>,
) {
  try {
    return Response.json(await effectiveDefinition(root), { headers });
  } catch {
    return Response.json(
      { error: "Definition unavailable or invalid" },
      { status: 503, headers },
    );
  }
}

/** Serve a curated, read-only status projection, never raw factory files. @throws If Git or HTML is unavailable. */
export function startDashboard({ root, port }: { root: string; port: number }) {
  const directory = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).trim();
  const web = join(root, "web/dist");
  const index = join(web, "index.html");
  const html = readFileSync(
    existsSync(index) ? index : join(import.meta.dir, "dashboard.html"),
    "utf8",
  );
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  async function staticPage(url: URL) {
    const path = url.pathname;
    if (path === "/api/events") return eventsResponse(directory, url, headers);
    if (path === "/" || path === "/index.html")
      return new Response(html, {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    if (/^\/assets\/[\w-][\w.-]*$/.test(path)) {
      const file = Bun.file(join(web, path));
      if (await file.exists()) return new Response(file, { headers });
    }
    if (path === "/api/definition") return definitionResponse(root, headers);
    return null;
  }
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      if (request.method !== "GET")
        return new Response("Read-only service", {
          status: 405,
          headers: { ...headers, allow: "GET" },
        });
      const url = new URL(request.url);
      const path = url.pathname;
      const page = await staticPage(url);
      if (page) return page;
      if (path !== "/api/status")
        return new Response("Not found", { status: 404, headers });
      const { snapshot, observations, fresh } =
        await readObservation(directory);
      const empty = {
        project: basename(root),
        pipelineSteps,
        lifecycle: lifecycleStatus(),
        stages,
        target: "",
        observedAt: snapshot?.observedAt ?? null,
        observations,
        enabled: false,
        fresh: false,
        tasks: [],
      };
      try {
        empty.target = targetBranch(root);
        const records = factoryRecords(join(directory, "factory"));
        if (!records)
          return Response.json({ ...empty, durable: "missing" }, { headers });
        const { state, tickets, reviews } = records;
        const steps = new Map(tickets.map((task) => [task.id, task.steps]));
        const observed = new Map(
          snapshot?.tasks.map((task) => [task.id, task]),
        );
        const publicTickets = new Map(tickets.map((task) => [task.id, task]));
        const repository = githubRepository(root);
        const rejections = rejectedReviews(reviews);
        const tasks = [
          ...new Set([...steps.keys(), ...Object.keys(state.runs)]),
        ].map((id) => {
          const ticket = publicTickets.get(id);
          const row = projectTask(
            id,
            steps.get(id) ?? [],
            Object.hasOwn(state.runs, id) ? state.runs[id] : undefined,
            ticket?.intake,
            observed.get(id),
            fresh,
            repository,
          );
          return {
            ...row,
            outcome: ticket?.outcome ?? null,
            rejections: rejections.get(id) ?? [],
          };
        });
        const counts = {
          planned: tasks.filter((task) => task.stage === "planned").length,
          queued: tasks.filter((task) => task.stage === "queued").length,
          accepted: tasks.filter((task) =>
            ["accepted", "merged"].includes(task.stage),
          ).length,
        };
        return Response.json(
          {
            ...empty,
            durable: "available",
            enabled: state.enabled,
            fresh,
            tasks,
            counts,
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
