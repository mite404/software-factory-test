import { execFileSync } from "node:child_process";
import { githubRepository } from "./github";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { automationRows, effectiveDefinition } from "./native";
import { authorizedControl } from "./control-token";
import {
  enqueueAutomationRequest,
  type AutomationRequest,
  evidenceOutcomes,
  factoryEvidence,
  factoryEvents,
  factoryRecords,
  fullyVerified,
  projectFullGate,
  lifecycleStatus,
  rejectionReasons,
  reviewSkipReasons,
  runCheckpoint,
  runStage,
  stages,
  taskSteps,
  type StopIncident,
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
  /** A first rejection's closed reason code; its evidence never crosses. */
  reason?: StopIncident["reason"];
  nextAttempt?: number;
  incident?: string;
  reportKind?: "candidate" | "blocked";
  gateOutcome?: (typeof evidenceOutcomes.gate)[number];
  reviewOutcome?: "pass" | "issues" | "skipped";
  skipReason?: (typeof reviewSkipReasons)[number];
};

const DETAIL_ACTIONS = new Set([
  "preparing",
  "setup-spawned",
  "rejected",
  "repair-resumed",
  "review-creating",
  "review-created",
  "review-sending",
  "review-sent",
  "report-received",
  "review-skipped",
  "gate-returned",
  "escalated",
  "parked",
]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const THREAD_ACTIONS = new Set([
  "created",
  "sending",
  "sent",
  "provider-continuation-intended",
  "provider-continuation-unknown",
  "provider-continuation-sent",
  "provider-recovered",
]);
const INCIDENT_ACTIONS = new Set([
  "notice-sent",
  "watchdog-nudge-intended",
  "watchdog-alert-intended",
  "watchdog-nudge-sent",
]);
const GATE_ATTEMPT_ACTIONS = new Set(["gate-started", "gate-interrupted"]);

function jsonDetail(detail: string): Record<string, unknown> {
  try {
    return record(JSON.parse(detail));
  } catch {
    return {};
  }
}

function eventDetail(action: string, detail: string): Record<string, unknown> {
  if (action === "accepted") return { revision: detail };
  if (GATE_ATTEMPT_ACTIONS.has(action))
    return { attempt: matchingString(detail, /^\d+$/) ? Number(detail) : null };
  if (INCIDENT_ACTIONS.has(action)) return { incident: detail };
  if (
    action === "gate-returned" &&
    evidenceOutcomes.gate.some((outcome) => outcome === detail)
  )
    return { gateOutcome: detail };
  if (THREAD_ACTIONS.has(action)) return { thread: detail };
  return DETAIL_ACTIONS.has(action) ? jsonDetail(detail) : {};
}

function matchingString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.exec(value)?.[0] === value
    ? value
    : undefined;
}

function durableFailure(error: unknown) {
  return new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]).has(String(errorCode(error)))
    ? "unavailable"
    : "invalid";
}

function positiveAttempt(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function verdictFields(
  detail: Record<string, unknown>,
  ticket: string,
): {
  attempt: number;
  revision: string;
  base: string;
  outcome: "pass" | "issues";
} | null {
  const attempt = positiveAttempt(detail.attempt);
  const revision = matchingString(detail.revision, /^[a-f0-9]{40}$/);
  const base = matchingString(detail.base, /^[a-f0-9]{40}$/);
  const outcome = detail.kind;
  if (
    detail.ticket !== ticket ||
    detail.stage !== "post-graft" ||
    !attempt ||
    !revision ||
    !base ||
    (outcome !== "pass" && outcome !== "issues")
  )
    return null;
  return { attempt, revision, base, outcome };
}

const eventFacts = new Map<
  string,
  (event: DashboardEvent, detail: Record<string, unknown>) => void
>([
  [
    "report-received",
    (event, detail) => {
      if (
        detail.reportKind === "blocked" ||
        (detail.reportKind === "candidate" && event.revision)
      )
        event.reportKind = detail.reportKind;
    },
  ],
  [
    "review-skipped",
    (event, detail) => {
      event.skipReason = reviewSkipReasons.find(
        (reason) => reason === detail.skipReason,
      );
      if (event.skipReason && event.attempt && event.revision)
        event.reviewOutcome = "skipped";
    },
  ],
  [
    "gate-returned",
    (event, detail) => {
      event.gateOutcome = evidenceOutcomes.gate.find(
        (outcome) => outcome === detail.gateOutcome,
      );
    },
  ],
  [
    "rejected",
    (event, detail) => {
      event.nextAttempt = positiveAttempt(detail.nextAttempt);
      event.reason = Object.values(rejectionReasons).find(
        (reason) => reason === detail.reason,
      );
    },
  ],
]);

function publicEvent(
  row: NonNullable<ReturnType<typeof factoryEvents>>[number],
): DashboardEvent {
  const event: DashboardEvent = {
    id: row.id,
    at: row.at,
    ticket: row.ticket,
    action: row.action,
  };
  if (row.action === "review-verdict") {
    const verdict = verdictFields(jsonDetail(row.detail), row.ticket);
    return verdict
      ? {
          ...event,
          attempt: verdict.attempt,
          revision: verdict.revision,
          reviewOutcome: verdict.outcome,
        }
      : event;
  }
  const detail = eventDetail(row.action, row.detail);
  event.attempt = positiveAttempt(detail.attempt);
  event.revision = matchingString(detail.revision, /^[a-f0-9]{40}$/);
  event.thread = matchingString(detail.thread, /^T-[\w-]+$/);
  event.incident = matchingString(detail.incident, uuid);
  eventFacts.get(row.action)?.(event, detail);
  if (event.incident && detail.reason === "verification-rejected")
    event.reason = detail.reason;
  return event;
}

function validEventKeys(params: URLSearchParams) {
  const keys = [...params.keys()];
  return (
    new Set(keys).size === keys.length &&
    keys.every((key) => key === "after" || key === "limit")
  );
}

function eventBounds(url: URL) {
  const after = url.searchParams.get("after") ?? "0";
  const limit = url.searchParams.get("limit") ?? "100";
  if (
    !validEventKeys(url.searchParams) ||
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
    return Response.json(
      {
        durable: durableFailure(error),
        events: [],
        error: "Durable status unavailable.",
      },
      { status: 503, headers },
    );
  }
}

/** Public metadata of one preserved artifact; its content, path and producing tool never cross. */
export type DashboardEvidence = {
  attempt: number;
  kind: keyof typeof evidenceOutcomes;
  revision: string;
  outcome: string;
  definition: string | null;
  sha256: string;
  bytes: number;
  at: string;
  preserved: boolean;
};

function publicEvidence(
  row: NonNullable<ReturnType<typeof factoryEvidence>>[number],
): DashboardEvidence {
  const outcomes: readonly string[] = evidenceOutcomes[row.kind] ?? [];
  const revision = matchingString(row.revision, /^[a-f0-9]{40}$/);
  const sha256 = matchingString(row.sha256, /^[a-f0-9]{64}$/);
  const definition =
    row.definition === null
      ? null
      : matchingString(row.definition, /^[a-f0-9]{64}$/);
  if (
    !revision ||
    !sha256 ||
    definition === undefined ||
    !outcomes.includes(row.outcome)
  )
    throw new Error("Invalid evidence record");
  return {
    attempt: row.attempt,
    kind: row.kind,
    revision,
    outcome: row.outcome,
    definition,
    sha256,
    bytes: row.bytes,
    at: row.at,
    preserved: row.intact,
  };
}

// Only a well-formed known ticket selects records; no request value ever names a file.
function evidenceResponse(
  directory: string,
  url: URL,
  headers: Record<string, string>,
) {
  const ticket = matchingString(
    url.searchParams.get("ticket"),
    /^[a-zA-Z0-9_-]+$/,
  );
  if (!ticket || [...url.searchParams.keys()].some((key) => key !== "ticket"))
    return Response.json(
      { error: "Invalid evidence query" },
      { status: 400, headers },
    );
  try {
    const rows = factoryEvidence(join(directory, "factory"), ticket);
    if (rows === undefined)
      return Response.json(
        { error: "Unknown ticket" },
        { status: 404, headers },
      );
    return Response.json(
      {
        durable: rows ? "available" : "missing",
        ticket,
        evidence: rows?.map(publicEvidence) ?? [],
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        durable: durableFailure(error),
        evidence: [],
        error: "Durable evidence unavailable.",
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

export type DashboardAutomation = Omit<
  ReturnType<typeof automationRows>[number],
  "schedule"
> & {
  schedule: string | null;
  requests: AutomationRequest[];
};

function dashboardAutomations(
  records: NonNullable<ReturnType<typeof factoryRecords>>,
): DashboardAutomation[] {
  const requests = Map.groupBy(records.requests, (request) => request.name);
  const rows: DashboardAutomation[] = automationRows(records.state).map(
    (row) => ({
      ...row,
      requests: requests.get(row.name) ?? [],
    }),
  );
  for (const [name, history] of requests) {
    if (rows.some((row) => row.name === name)) continue;
    rows.push({
      name,
      schedule: null,
      enabled: false,
      lastRunAt: null,
      lastOutcome: null,
      requests: history,
    });
  }
  return rows;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid status");
  return { ...value };
}

function parseAutomationAction(body: unknown) {
  const input = record(body);
  if (Object.keys(input).join() !== "action") throw new Error("Invalid action");
  const action = (["enable", "disable", "run"] as const).find(
    (value) => value === input.action,
  );
  if (!action) throw new Error("Invalid action");
  return action;
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

function matchesSkippedReview(
  event: DashboardEvent,
  work: Run | undefined,
  base: unknown,
) {
  if (work?.kind === "done")
    return work.revision === event.revision && work.acceptedBase === base;
  return work?.kind === "running" && work.base === base;
}

function matchesDecision(
  event: DashboardEvent,
  work: Run | undefined,
  base: unknown,
) {
  if (!event.reviewOutcome) return false;
  const review = reviewFor(event.ticket, work);
  if (event.reviewOutcome !== "skipped")
    return review?.revision === event.revision && review?.base === base;
  return !review && matchesSkippedReview(event, work, base);
}

function recordedReferences(
  records: NonNullable<ReturnType<typeof factoryRecords>>,
) {
  const receipts = new Map<string, DashboardEvent>();
  const decisions = new Map<string, DashboardEvent>();
  for (const row of records.reviews) {
    if (row.action === "review-created") continue;
    const run = Object.hasOwn(records.state.runs, row.ticket)
      ? records.state.runs[row.ticket]
      : undefined;
    const event = publicEvent(row);
    if (!event.attempt || event.attempt !== attemptOf(run)) continue;
    if (event.reportKind) receipts.set(row.ticket, event);
    if (matchesDecision(event, runCheckpoint(run), jsonDetail(row.detail).base))
      decisions.set(row.ticket, event);
  }
  return { receipts, decisions };
}

// The first rejection that sent this attempt back, until its repair message is sent. A resume
// of a later stop raises the attempt past it, so an older rejection is never reused.
function projectRepair(run: Run | undefined) {
  if (
    run?.kind !== "running" ||
    run.incident ||
    !run.rejectedBy ||
    run.rejectedAttempt !== run.attempt - 1 ||
    run.delivery === "sent"
  )
    return null;
  return {
    reason: rejectionReasons[run.rejectedBy],
    attempt: run.rejectedAttempt,
  };
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
  const work = runCheckpoint(run);
  return (
    (work && "attempt" in work ? work.attempt : undefined) ??
    positiveAttempt(run?.incident?.attempt) ??
    null
  );
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
    id: matchingString(incident.id, uuid) ?? null,
    owner: reference(incident.owner, /^T-[\w-]+$/),
    reason: incident.reason,
    role: incident.cause?.role ?? null,
    thread: reference(incident.cause?.thread ?? null, /^T-[\w-]+$/),
    notifiedAt: iso(incident.notifiedAt),
  };
}

function projectRunLinks(id: string, run: Run | undefined) {
  const checkpoint = runCheckpoint(run);
  const review = reviewFor(id, checkpoint);
  return {
    reviewerThread: reference(review?.thread ?? null, /^T-[\w-]+$/),
    stop: projectStop(run?.incident),
    repair: projectRepair(run),
    parked: runStage(run).stage === "parked",
    // The owning worker's attempt; a repair after rejection raises it.
    attempt: attemptOf(run),
    waitingForForeman: runStage(run).stage === "escalated",
  };
}

function iso(at: number | null | undefined) {
  return typeof at === "number" ? new Date(at).toISOString() : null;
}

function stallTiming(run: Run | undefined) {
  if (run?.incident?.reason === "disconnected")
    return {
      reason: "disconnected",
      since: run.kind === "running" ? run.stallSample?.since : undefined,
      detectedAt: run.stageAt,
    };
  const timing = run?.watchdog;
  if (!timing) return null;
  const open = timing.alerts.find(
    (alert) => alert.kind === "unresolved" && alert.episode === timing.episode,
  );
  return open
    ? {
        reason: "no-lifecycle-progress",
        since: timing.progressAt,
        detectedAt: open.intendedAt,
      }
    : null;
}

function projectStall(run: Run | undefined, nudgeCount: number) {
  const stall = stallTiming(run);
  if (!stall) return null;
  const timing = run?.watchdog;
  return {
    id: matchingString(timing?.episode ?? run?.incident?.id, uuid) ?? null,
    reason: stall.reason,
    since: iso(stall.since),
    detectedAt: iso(stall.detectedAt),
    lastNudgedAt: iso(timing?.nudgedAt),
    nudgeCount,
  };
}

// Curated at acceptance; the raw report insight never leaves storage.
function projectAcceptance(run: Run | undefined) {
  return run?.kind === "done" && fullyVerified(run)
    ? { acceptedAt: iso(run.acceptedAt), summary: run.summary ?? null }
    : { acceptedAt: null, summary: null };
}

// The last gate's per-check results: names and statuses only, never commands or output.
function projectChecks(run: Run | undefined) {
  const work = runCheckpoint(run);
  const checks = work && "checks" in work ? work.checks : undefined;
  return checks
    ? {
        attempt: checks.attempt,
        results: checks.results.map(({ name, required, status }) => ({
          name,
          required,
          status,
        })),
      }
    : null;
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

function delivered(run: Run | undefined, review: ReturnType<typeof reviewFor>) {
  return (
    run?.kind === "running" && (review?.delivery ?? run.delivery) === "sent"
  );
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
  const open = declared === "unknown" && delivered(run, review);
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
    checks: projectChecks(run),
    ...(run?.fullGate ? { fullGate: projectFullGate(run) } : {}),
    evidence: {
      acceptance: fullyVerified(run) ? { revision: row.revision } : null,
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

function receiptReference(event: DashboardEvent | undefined) {
  return event
    ? {
        eventId: event.id,
        at: event.at,
        attempt: event.attempt,
        kind: event.reportKind,
        revision: event.revision ?? null,
      }
    : null;
}

function decisionReference(event: DashboardEvent | undefined) {
  return event
    ? {
        eventId: event.id,
        at: event.at,
        attempt: event.attempt,
        outcome: event.reviewOutcome,
        revision: event.revision,
        reason: event.skipReason ?? null,
      }
    : null;
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

/** Serve curated status and authenticated automation intents, never raw factory files.
 * @param controlOrigin Exact public origin for POSTs behind a portal. Proxy headers are not identity.
 * @throws If Git or HTML is unavailable.
 */
export function startDashboard({
  root,
  port,
  controlOrigin,
}: {
  root: string;
  port: number;
  controlOrigin?: string;
}) {
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
    "content-security-policy": "frame-ancestors 'none'",
  };
  function controlRefusal(request: Request, url: URL) {
    if (request.headers.get("origin") !== (controlOrigin ?? url.origin))
      return new Response("Origin refused", { status: 403, headers });
    if (
      !authorizedControl(
        join(directory, "factory"),
        request.headers.get("authorization"),
      )
    )
      return new Response("Authorization required", { status: 401, headers });
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.split(";")[0]!.trim() !== "application/json")
      return new Response("JSON required", { status: 415, headers });
    return null;
  }
  async function requestAutomation(request: Request, url: URL, name: string) {
    const refusal = controlRefusal(request, url);
    if (refusal) return refusal;
    let action: ReturnType<typeof parseAutomationAction>;
    try {
      action = parseAutomationAction(await request.json());
    } catch {
      return new Response("Invalid action", { status: 400, headers });
    }
    try {
      const records = factoryRecords(join(directory, "factory"));
      if (!records)
        return new Response("Durable storage unavailable", {
          status: 503,
          headers,
        });
      if (!Object.hasOwn(records.state.automations ?? {}, name))
        return new Response("Unknown automation", { status: 404, headers });
      const id = enqueueAutomationRequest(
        join(directory, "factory"),
        name,
        action,
      );
      return Response.json({ id, status: "pending" }, { status: 202, headers });
    } catch {
      return new Response("Durable storage unavailable", {
        status: 503,
        headers,
      });
    }
  }
  async function writeResponse(request: Request, url: URL) {
    const match = /^\/api\/automations\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && match)
      return requestAutomation(request, url, match[1]!);
    return new Response("Read-only service", {
      status: 405,
      headers: { ...headers, allow: "GET" },
    });
  }
  async function staticPage(url: URL) {
    const path = url.pathname;
    if (path === "/api/events") return eventsResponse(directory, url, headers);
    if (path === "/api/evidence")
      return evidenceResponse(directory, url, headers);
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
    maxRequestBodySize: 1024,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET") return writeResponse(request, url);
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
        automations: [] as DashboardAutomation[],
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
        const { receipts, decisions } = recordedReferences(records);
        const nudges = new Map(
          records.nudges.map(({ ticket, count }) => [ticket, count]),
        );
        const tasks = [
          ...new Set([...steps.keys(), ...Object.keys(state.runs)]),
        ].map((id) => {
          const ticket = publicTickets.get(id);
          const run = Object.hasOwn(state.runs, id)
            ? state.runs[id]
            : undefined;
          const row = projectTask(
            id,
            steps.get(id) ?? [],
            run,
            ticket?.intake,
            observed.get(id),
            fresh,
            repository,
          );
          return {
            ...row,
            outcome: ticket?.outcome ?? null,
            rejections: rejections.get(id) ?? [],
            stall: projectStall(run, nudges.get(id) ?? 0),
            reportReceipt: receiptReference(receipts.get(id)),
            reviewDecision: decisionReference(decisions.get(id)),
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
            automations: dashboardAutomations(records),
          },
          { headers },
        );
      } catch (error) {
        return Response.json(
          {
            ...empty,
            durable: durableFailure(error),
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
    controlOrigin: process.env.FACTORY_CONTROL_ORIGIN,
  });
  process.stdout.write(`Factory dashboard listening on port ${server.port}\n`);
}
