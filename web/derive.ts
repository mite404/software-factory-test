import type {
  DashboardAutomation,
  DashboardEvent,
  DashboardSnapshot,
} from "../factory/dashboard";
import { pipelineSteps } from "../factory/pipeline";
import type {
  AutomationAction,
  AutomationRequest,
  CheckStatus,
  Stage,
  StopIncident,
  stages as declaredStages,
} from "../factory/persistence";
import type { Actor } from "../factory/pipeline";

export type EventRow = DashboardEvent & {
  time: string;
  href: string | null;
};

function pendingAutomationRequest(
  requests: AutomationRequest[],
  queued: number | null,
) {
  return (
    requests.some((request) => request.status === "pending") ||
    (queued !== null && !requests.some((request) => request.id === queued))
  );
}

function automationMessage(
  latest: AutomationRequest | undefined,
  pending: boolean,
  sending: boolean,
  error: string,
) {
  if (error) return error;
  if (sending) return "Submitting…";
  if (pending) return "Pending · waiting for a connected owner wake";
  if (!latest) return "No requests";
  return `${latest.action} ${latest.status}${latest.reason ? ` · ${latest.reason}` : ""}`;
}

/** Render recorded automation state without optimistic switches; a receipt stays pending until polled. */
export function automationView(
  row: DashboardAutomation,
  queued: number | null,
  sending: boolean,
  error: string,
  hasToken: boolean,
) {
  const pending = pendingAutomationRequest(row.requests, queued);
  const nextAction: AutomationAction = row.enabled ? "disable" : "enable";
  return {
    pending,
    disabled: !hasToken || sending || pending || row.schedule === null,
    schedule:
      row.schedule === null ? "No longer loaded" : `${row.schedule} · UTC`,
    nextAction,
    switchLabel: row.enabled ? "On" : "Off",
    message: automationMessage(row.requests.at(-1), pending, sending, error),
    lastRun:
      row.lastRunAt === null
        ? "never"
        : new Date(row.lastRunAt).toLocaleString(),
    lastOutcome: row.lastOutcome ?? "not recorded",
  };
}

/**
 * Suppress historical notices until an earlier successful page exhausted the event log.
 * @param received Null for a failed request, which must not establish catch-up.
 * @param limit The requested page size; a full page does not prove catch-up.
 */
export function eventBatch(
  caughtUp: boolean,
  received: DashboardEvent[] | null,
  limit: number,
) {
  return {
    caughtUp: caughtUp || (received !== null && received.length < limit),
    news: caughtUp ? (received ?? []) : [],
  };
}

/** Derive oldest-first log rows, optionally restricted to one exact ticket ID. */
export function eventRows(events: DashboardEvent[], ticket = ""): EventRow[] {
  return events
    .filter((event) => !ticket || event.ticket === ticket)
    .map((event) => ({
      ...event,
      time: new Date(event.at).toLocaleTimeString(),
      href:
        event.thread && /^T-[\w-]+$/.exec(event.thread)?.[0] === event.thread
          ? `https://ampcode.com/threads/${event.thread}`
          : null,
    }));
}

// evidence is added per task by GET /api/status but is not part of the exported snapshot type.
// evidence.review is the cold review record bound to the task's current revision; null means none
// is recorded, which on an accepted task is not proof that review was skipped.
export type FeedTask = DashboardSnapshot["tasks"][number] & {
  attempt?: number | null; // the worker's current attempt, null before a worker exists
  evidence?: { review: { pending?: boolean; attempt?: number } | null };
  merge?: { pr: number; url: string | null } | null;
  workerThread?: string | null;
  reviewerThread?: string | null;
  stop?: {
    reason: StopIncident["reason"];
    role: "worker" | "reviewer" | null;
    thread: string | null;
  } | null;
  repair?: { reason: StopIncident["reason"]; attempt: number } | null; // sent back, not stopped
  parked?: boolean;
  rejections?: { attempt: number; thread: string }[];
  stage: Stage; // the factory's named stage; the page prints it, never infers it
  kind?: string | null; // the run's saved kind, a key of the lifecycle table; null before a run
  stopName?: string | null; // the declared stop holding the run, a key of that kind's stops
  stageSince?: string | null; // when the run entered its stage, null for older state
  actor?: Actor | null; // who must act now; null is nobody
  clearsAt?: string | null; // when a provider limit clears, if known
  step?: number | null; // index into pipelineSteps where the run sits; null before one exists
  rejectedBy?: "gate" | "review" | "merge" | null; // the step that rejected the last attempt
  summary?: string | null; // curated public one-line outcome, set at acceptance
  // The last gate's per-check results (a flat verify is one check); null before any gate returned.
  checks?: { attempt: number; results: CheckStatus[] } | null;
};

// The declared lifecycle table as GET /api/status serves it: only what the drawing reads.
type TableExit = ({ action: string } | { event: string }) & {
  actor: Actor;
  when: string;
};
type TableStop = {
  actor: Actor;
  reasons: readonly string[];
  recovery: string;
  exits: readonly TableExit[];
  foremanOnly?: string;
};
export type LifecycleTable = Record<
  string,
  {
    actor: Actor;
    exits: readonly TableExit[];
    stops: Record<string, TableStop>;
  }
>;

// What the page says about a ticket: the declared status of its stage, or the live activity of a
// run in flight.
type DeclaredStatus = (typeof declaredStages)[number]["status"];
type Status = DeclaredStatus | NonNullable<FeedTask["activity"]>;

// A feed task with the word the page shows for it.
type Shown = FeedTask & { status: Status };

// One step chip of a COMING row, placed in SVG units.
type Chip = { text: string; x: number; width: number };

// What GET /api/status returns: the snapshot plus freshness, or an empty feed before first run.
export type Feed = {
  project: string;
  automations?: DashboardAutomation[];
  target: string; // branch the integrator fast-forwards onto
  observedAt: string | null;
  enabled: boolean;
  fresh: boolean;
  pipelineSteps?: readonly (typeof pipelineSteps)[number][];
  lifecycle?: LifecycleTable; // the declared run lifecycle; the lifecycle graph is drawn from it
  stages: readonly { id: Stage; actor: Actor | null; status: DeclaredStatus }[]; // named stages, in pipeline order
  tasks: FeedTask[];
};

// One ticket as the page shows it. Missing tickets pad fixed-size rows as "empty".
type Cell = {
  status: Status | "empty";
  id: string;
  label: string;
  href: string | null;
  stage: number; // pipeline stages finished, 0 to 7
};

// One ticket with everything the SPEC-01 device (web/spec) prints about it.
export type Ticket = Cell & {
  title: string;
  steps: string[]; // the state of each of the 7 stages, as on a COMING row
  plan: string[]; // the ticket's own authored steps, uncut
  revision: string; // short hash, "" until the ticket lands
  pullRequest: { number: number; href: string | null } | null;
  review: "pending" | "recorded" | "none"; // the cold review record on its current revision
  attempt: number | null;
  stageLinks: (string | null)[];
  stop: { role: "worker" | "reviewer" | null; href: string | null } | null;
  reason: string; // the stop's or repair's fixed sentence, "" when neither is recorded
  parked: boolean;
  rejections: { attempt: number; href: string | null }[];
  lifecycle: string; // "<stage> · <actor>[ · <limit clear time>]", "" for feeds without stages
  // The last gate's checks in run order, [] when none were recorded. The label says in print what
  // the chip's style shows: "lint · fail · advisory".
  checks: (CheckStatus & { label: string })[];
};

// A ticket on the lifecycle graph, placed by the factory's own kind, stop and stage.
type Marker = {
  id: string;
  href: string | null;
  stage: string;
  step: string; // the pipeline step label, "" when the run sits at none
  actor: Actor | null;
  since: string; // when the stage began, "2026-11-14 01:47Z"; "" for runs saved before stamping
  text: string; // the ticket, its curated stage and who must act now, as the page prints it
  clears: string; // "clears in 25 min" for a provider limit with a known clear time
};

// One state of the graph: a run kind, a declared stop that holds a run, or a stage before a run.
export type GraphNode = {
  id: string; // "running", "running/providerLimit" or a pre-run stage
  label: string;
  actor: Actor | null;
  urgency: number; // index into URGENCY; smaller must be acted on sooner
  held: boolean; // a stop, or a kind that only holds stopped runs
  clock: boolean; // waits for a clock, not a person
  declared: boolean; // false for stages the table does not cover
  exits: { name: string; actor: Actor; when: string }[]; // only what the table declares
  exitless: boolean; // declared, and the table gives it no exit at all
  reasons: string[];
  note: string; // the table's reason a stop has no factory exit
  uncertain: boolean; // its outcome is unknown, so it says so as well as showing its colour
  markers: Marker[];
  tone: "" | "now" | "done" | "stop"; // set once tickets are placed; "" is unlit
  cues: string[]; // what the box says in print, not by colour alone
};
export type GraphColumn = GraphNode & { stops: GraphNode[] };

// A stopped ticket's banner, the facts the feed carries about who must act and why.
type Banner = {
  id: string;
  urgency: number; // index into URGENCY
  tone: "danger" | "warning"; // a clock wait is a warning, a wait on a person is danger
  title: string;
  text: string; // the declared reason code and the exit actions the table gives the stop
  cause: { role: "worker" | "reviewer"; href: string | null } | null;
  when: string; // when the stage began and when a limit clears; the stop time is not recorded
};

export type Graph = {
  waiting: number; // tickets the operator must act on
  path: GraphColumn[]; // the states a run passes through, left to right
  stops: GraphColumn[]; // every state that has stops, or only holds stopped runs, most urgent first
  banners: Banner[]; // stopped tickets, most urgent first
};

// One recorded event, worded for a notification.
type News = {
  at: string;
  tone: "success" | "danger" | "info";
  title: string;
  text: string;
};

// Everything the page paints, fully resolved so main.ts only copies values into the SVG.
export type View = {
  state: "live" | "paused" | "stale";
  automations: DashboardAutomation[];
  project: string;
  target: string; // merge target branch, cut to fit its pill
  observed: string;
  tally: string;
  counts: { landed: number; queued: number; blocked: number }; // the tally, as numbers
  tickets: Ticket[]; // every ticket in feed order, for search, paging and the landed card
  pipelineSteps: NonNullable<Feed["pipelineSteps"]>;
  graph: Graph | null; // null for a feed without the lifecycle table
  news: News[]; // newly received durable events
  head: string;
  next: string;
  reviewing: boolean; // a fresh pending review, including the first and repeated polls
  reviewFinished: "passed" | "failed" | null; // release once on an observed review outcome
  waiting: string;
  slots: number; // lit submission slots: idle builders whose work is not accepted yet
  builders: Cell[]; // 4 rows: tickets that had not landed one poll ago
  main: {
    on: boolean;
    last: boolean;
    id: string;
    label: string;
    href: string | null;
  }[]; // 7 dots, newest first, beside the integrator
  queue: (Cell & { tag: string })[]; // 10 tickets in order, windowed around the active one
  // 3 rows: the next tickets that have not landed, with the stage each one has reached
  coming: {
    id: string;
    title: string;
    status: Cell["status"];
    steps: string[];
    chips: Chip[]; // the ticket's own steps; empty on the ACTIVE row and for legacy tickets
  }[];
  landed: boolean; // a ticket was accepted since the previous poll
  reviewed: boolean; // that ticket has a recorded cold review, so its landing detours through it
  startRow: number; // builder row (1-4) the foreman hands a queued or blocked ticket to, 0 for none
  outRow: number; // builder row (1-4) the landing packet leaves from, 0 for none
  backRow: number; // builder row (1-4) a blocked packet returns to, 0 for none
};

const ROWS = 4;
const MAIN_DOTS = 7;
const QUEUE_DOTS = 10;
const COMING_ROWS = 3;
const CHIP_X = 311; // where a row's chips start, under the ACTIVE stage pills
const CHIP_END = 1233;
const CHIP_GAP = 20; // room for the arrow between two chips
const QUIET = ["accepted", "queued", "empty"];

function pad<T>(items: T[], length: number): (T | undefined)[] {
  return Array.from({ length }, (_, i) => items[i]);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Public titles are the ticket id, or the id plus a label such as "- post-graft review (sent)".
// The id is always printed beside the title, so only the label is worth showing.
function label(task: FeedTask): string {
  if (task.title === task.id) return "";
  const prefix = `${task.id} - `;
  return task.title.startsWith(prefix)
    ? task.title.slice(prefix.length)
    : task.title;
}

function describe(task: Shown): string {
  const revision = task.revision ? ` · ${task.revision.slice(0, 7)}` : "";
  // The tooltip is one unwrapped line, so a brief-length title is cut to fit.
  const title = label(task) && ` · ${cut(label(task), 40)}`;
  // ponytail: the feed has no public description, so the second line is the first authored step
  // label. Swap in the ticket's public outcome once planned intake adds one to the feed.
  const about = task.steps[0] ? `\n${cut(task.steps[0], 30)}` : "";
  return `${task.id}${title} · ${task.status}${revision}${about}`;
}

function cell(task: Shown | undefined): Cell {
  if (!task)
    return { status: "empty", id: "", label: "", href: null, stage: 0 };
  return {
    status: task.status,
    id: task.id,
    label: describe(task),
    href:
      task.thread && /^T-[\w-]+$/.exec(task.thread)?.[0] === task.thread
        ? `https://ampcode.com/threads/${task.thread}`
        : null,
    stage: namedStages(task, pipelineSteps.length).filter(
      (step) => step === "done",
    ).length,
  };
}

const STOPPED = new Set(["escalated", "parked", "blocked", "uncertain"]);

// One fixed public sentence per factory reason code; report, log and review text never print.
const REASONS: Record<StopIncident["reason"], string> = {
  "verification-rejected":
    "Verification rejected the repaired candidate; it waits for a decision.",
  "gate-failed": "The pinned gate failed.",
  "review-rejected": "Cold review rejected the candidate.",
  "worker-blocked": "The builder reported that it is blocked.",
  "worker-error": "Its thread stopped with an error.",
  "provider-limit": "The model provider's usage limit was reached.",
  "approval-required": "Its thread waits for a tool approval.",
  "preparation-failed": "The worktree setup command failed.",
  "preparation-interrupted": "The worktree setup was interrupted.",
  "delivery-unknown": "Whether its last message arrived is unknown.",
  "creation-unknown": "Whether its thread was created is unknown.",
  "target-changed": "The integration target moved under the candidate.",
  "review-identity-changed":
    "The candidate or base changed after its review began.",
  "evidence-missing":
    "No intact gate or review proof is bound to the candidate revision.",
  "brief-incomplete": "Its brief is incomplete.",
};

function repairText({ reason, attempt }: NonNullable<FeedTask["repair"]>) {
  return `${REASONS[reason]} Attempt ${attempt} goes back to its builder.`;
}

function reasonText({ stop, repair }: FeedTask): string {
  if (stop) return REASONS[stop.reason];
  return repair ? repairText(repair) : "";
}

// A first rejection's notice names its recorded cause and the attempt that failed.
function noticeText({ at, attempt, revision, reason }: DashboardEvent): string {
  if (reason && attempt) return `${repairText({ reason, attempt })} · ${at}`;
  return [at, attempt ? `attempt ${attempt}` : "", revision?.slice(0, 7)]
    .filter(Boolean)
    .join(" · ");
}

// The factory's own step and stage, when the feed carries them; nothing is inferred.
function namedStages(task: FeedTask, count: number): string[] {
  const { stage, step } = task;
  if (stage === "accepted" || stage === "merged")
    return Array.from({ length: count }, () => "done");
  const mark =
    STOPPED.has(stage!) || (task.stop && stage !== "rate-limited")
      ? "fail"
      : "now";
  return Array.from({ length: count }, (_, i) =>
    step === null || step === undefined
      ? ""
      : i < step
        ? "done"
        : i === step
          ? mark
          : "",
  );
}

function pullRequest(merge: FeedTask["merge"]): Ticket["pullRequest"] {
  if (!merge || !Number.isSafeInteger(merge.pr) || merge.pr <= 0) return null;
  const parts =
    /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(
      merge.url ?? "",
    );
  if (
    !parts ||
    [".", ".."].includes(parts[2]!) ||
    parts[3] !== String(merge.pr)
  )
    return { number: merge.pr, href: null };
  const href = `https://github.com/${parts[1]}/${parts[2]}/pull/${merge.pr}`;
  return { number: merge.pr, href: href === merge.url ? href : null };
}

function threadHref(thread: string | null | undefined): string | null {
  return thread && /^T-[\w-]+$/.exec(thread)?.[0] === thread
    ? `https://ampcode.com/threads/${thread}`
    : null;
}

function stageLink(
  task: FeedTask,
  stage: NonNullable<Feed["pipelineSteps"]>[number],
  state: string | undefined,
) {
  if (state === "fail") return threadHref(task.stop?.thread);
  if (stage.id === "review") return threadHref(task.reviewerThread);
  return stage.actor === "model" ? threadHref(task.workerThread) : null;
}

function ticketLinks(
  task: FeedTask,
  stages: NonNullable<Feed["pipelineSteps"]>,
) {
  const states = namedStages(task, stages.length);
  return {
    stageLinks: stages.map((stage, i) => stageLink(task, stage, states[i])),
    stop: task.stop
      ? { role: task.stop.role, href: threadHref(task.stop.thread) }
      : null,
    rejections: (task.rejections ?? []).map((row) => ({
      attempt: row.attempt,
      href: threadHref(row.thread),
    })),
  };
}

function lifecycle({ stage, actor, clearsAt }: FeedTask): string {
  if (!stage) return "";
  const clears = clearsAt ? ` · ${clearsAt.slice(11, 16)}Z` : "";
  return `${stage} · ${actor ?? "nobody"}${clears}`;
}

function ticket(
  task: Shown,
  stages: NonNullable<Feed["pipelineSteps"]>,
): Ticket {
  const review = task.evidence?.review;
  return {
    ...cell(task),
    title: label(task),
    steps: namedStages(task, stages.length),
    stage: namedStages(task, stages.length).filter((step) => step === "done")
      .length,
    ...ticketLinks(task, stages),
    reason: reasonText(task),
    parked: task.parked === true,
    lifecycle: lifecycle(task),
    plan: task.steps,
    revision: task.revision?.slice(0, 7) ?? "",
    pullRequest: pullRequest(task.merge),
    review: review?.pending ? "pending" : review ? "recorded" : "none",
    // Older feeds carry the attempt only on a pending review record.
    attempt: task.attempt ?? review?.attempt ?? null,
    checks: checkResults(task),
  };
}

function checkResults(task: FeedTask): Ticket["checks"] {
  return (task.checks?.results ?? []).map((check) => ({
    ...check,
    label: [
      check.name,
      ...(check.status === "pass" ? [] : [check.status]),
      ...(check.required ? [] : ["advisory"]),
    ].join(" · "),
  }));
}

// Lay step labels out left to right from the chip column; steps that do not fit are dropped.
function chips(labels: string[]): Chip[] {
  const placed: Chip[] = [];
  let x = CHIP_X;
  for (const label of labels) {
    const text = cut(label, 32);
    const width = Math.round(text.length * 6.4 + 18);
    if (x + width > CHIP_END) break;
    placed.push({ text, x, width });
    x += width + CHIP_GAP;
  }
  return placed;
}

// Row 0 is the ACTIVE ticket, which keeps the stage pills instead of its own steps.
function ticketRow(
  task: Shown | undefined,
  row: number,
  stages: NonNullable<Feed["pipelineSteps"]>,
): View["coming"][number] {
  if (!task)
    return {
      id: "",
      title: "",
      status: "empty",
      steps: Array.from({ length: stages.length }, () => ""),
      chips: [],
    };
  return {
    id: task.id,
    title: cut(label(task), 32),
    status: task.status,
    steps: namedStages(task, stages.length),
    chips: row ? chips(task.steps) : [],
  };
}

function observed(feed: Feed, now: number): string {
  if (!feed.observedAt) return "no observation yet";
  const seconds = Math.round((now - Date.parse(feed.observedAt)) / 1000);
  return `observed ${Math.max(0, seconds)} s ago`;
}

function counts(tasks: Shown[]): View["counts"] {
  const count = (status: Status) =>
    tasks.filter((task) => task.status === status).length;
  return {
    landed: count("accepted"),
    queued: count("queued"),
    blocked: count("blocked"),
  };
}

function tally({ landed, queued, blocked }: View["counts"]): string {
  return [
    `${landed} landed`,
    `${queued} queued`,
    ...(blocked ? [`${blocked} blocked`] : []),
  ].join(" · ");
}

// The feed says "blocked" for a few seconds while a cold review is being dispatched. A pending
// review is work in progress, so it counts as working everywhere on the page.
// The feed lists an admitted ticket after the planned ones it was picked from; every admitted
// ticket runs before any planned one, so planned tickets go last and the rest keep their order.
function settle(feed: Feed): Omit<Feed, "tasks"> & { tasks: Shown[] } {
  const declared = new Map(
    feed.stages.map((entry) => [entry.id, entry.status]),
  );
  const tasks = feed.tasks.map((task): Shown => ({
    ...task,
    status: task.stop
      ? "blocked"
      : task.evidence?.review?.pending
        ? "working"
        : (task.activity ?? declared.get(task.stage)!),
  }));
  const planned = (task: Shown) => task.status === "planned";
  return {
    ...feed,
    tasks: [...tasks.filter((t) => !planned(t)), ...tasks.filter(planned)],
  };
}

// Who must act, most urgent first: the operator, the Foreman, a clock, work in progress, quiet.
const URGENCY = ["operator", "foreman", "clock", "work", "quiet"];
// The kinds a run passes through, in order. Every other kind in the table holds stopped runs.
const PATH = ["preparing", "creating", "running", "done"];

function urgency(actor: Actor | null, clock: boolean, quiet: boolean): number {
  const who =
    actor === "operator" || actor === "foreman"
      ? actor
      : clock
        ? "clock"
        : quiet
          ? "quiet"
          : "work";
  return URGENCY.indexOf(who);
}

function exits(list: readonly TableExit[]): GraphNode["exits"] {
  return list.map((exit) => ({
    name: "action" in exit ? exit.action : exit.event,
    actor: exit.actor,
    when: exit.when,
  }));
}

function node(
  id: string,
  label: string,
  rest: Partial<GraphNode> & { actor: Actor | null },
): GraphNode {
  return {
    id,
    label,
    urgency: urgency(rest.actor, rest.clock ?? false, false),
    held: false,
    clock: false,
    declared: true,
    exits: [],
    exitless: false,
    reasons: [],
    note: "",
    uncertain: id.startsWith("uncertain"),
    markers: [],
    tone: "",
    cues: [],
    ...rest,
  };
}

function stopNode(kind: string, name: string, stop: TableStop): GraphNode {
  const clock = stop.recovery === "wait";
  // The table keys stops in camel case; the id keeps the key, the label reads as words.
  const words = name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  return node(`${kind}/${name}`, `${kind} · ${words}`, {
    actor: stop.actor,
    clock,
    held: true,
    exits: exits(stop.exits),
    exitless: stop.exits.length === 0,
    reasons: [...stop.reasons],
    note: stop.foremanOnly ?? "",
  });
}

function column(
  kind: string,
  entry: LifecycleTable[string],
  held: boolean,
): GraphColumn {
  const stops = Object.entries(entry.stops)
    .map(([name, stop]) => stopNode(kind, name, stop))
    .sort((a, b) => a.urgency - b.urgency);
  const own = node(kind, kind, {
    actor: entry.actor,
    held,
    exits: exits(entry.exits),
    // Exitless means no declared exit on the kind or on any of its stops.
    exitless:
      entry.exits.length === 0 &&
      stops.every((stop) => stop.exits.length === 0),
  });
  if (kind === "done") own.urgency = urgency(entry.actor, false, true);
  return { ...own, stops };
}

function when(at: string | null | undefined): string {
  return at ? `${at.slice(0, 10)} ${at.slice(11, 16)}Z` : "";
}

function countdown(clearsAt: string | null | undefined, now: number): string {
  if (!clearsAt) return "";
  const minutes = Math.ceil((Date.parse(clearsAt) - now) / 60_000);
  if (minutes <= 0) return "clearing now";
  return minutes < 60
    ? `clears in ${minutes} min`
    : `clears in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function marker(
  task: FeedTask,
  steps: NonNullable<Feed["pipelineSteps"]>,
  now: number,
): Marker {
  const stage = task.stage ?? "";
  const step = steps[task.step ?? -1]?.label ?? "";
  const actor = task.actor ?? null;
  const clears = countdown(task.clearsAt, now);
  return {
    id: task.id,
    href: threadHref(task.thread),
    stage,
    step,
    actor,
    since: when(task.stageSince),
    clears,
    // The feed's stage and actor, never the enclosing node's declared actor: a gating run sits on
    // running, and accepted and merged runs share done.
    text: [task.id, stage, `${actor ?? "nobody"} acts`, step, clears]
      .filter(Boolean)
      .join(" · "),
  };
}

// A kind node has no exits of its own when its stops carry them; with no recorded stop the
// banner names those declared exits instead of calling the run terminal.
type Placed = GraphNode & { stops?: GraphNode[] };

function exitText(at: Placed): string {
  const own = at.exits.map((exit) => exit.name);
  const declared = (at.stops ?? []).flatMap((stop) =>
    stop.exits.map((exit) => exit.name),
  );
  if (own.length) return ` Exit: ${own.join(", ")}.`;
  if (declared.length)
    return ` Stop not recorded; declared exits by stop: ${[...new Set(declared)].join(", ")}.`;
  return " No exit in the factory.";
}

function bannerText(task: FeedTask, at: Placed): string {
  return `${reasonText(task) || "Reason not recorded."}${exitText(at)}`;
}

function bannerWhen({ since, clears }: Marker): string {
  // stageSince is when the stage began, not when a stop was recorded: a reviewer can stop for
  // approval long after its stage began, and the feed records no stop time.
  return [since && `Stage began ${since}.`, clears && `${clears}.`]
    .filter(Boolean)
    .join(" ");
}

function causeOf(stop: FeedTask["stop"]): Banner["cause"] {
  return stop?.role ? { role: stop.role, href: threadHref(stop.thread) } : null;
}

function banner(task: FeedTask, at: Placed, found: Marker): Banner {
  return {
    id: task.id,
    urgency: urgency(found.actor, task.stage === "rate-limited", false),
    tone: found.actor === "computer" ? "warning" : "danger",
    title: `${task.id} · ${at.label} · ${found.actor ?? "nobody"} must act`,
    text: bannerText(task, at),
    cause: causeOf(task.stop),
    when: bannerWhen(found),
  };
}

// Green done, red stopped, orange now. A clock wait stays dim, and planned and queued tickets
// wait for work to start, so their states stay unlit; their markers still show.
function toneOf(own: GraphNode): GraphNode["tone"] {
  if (!own.markers.length || !own.declared || own.clock) return "";
  if (own.held) return "stop";
  return own.id === "done" ? "done" : "now";
}

// What a state shows once tickets sit on it: its colour, and the same facts in print.
function look(own: GraphNode) {
  own.tone = toneOf(own);
  own.cues = [
    own.tone === "stop" && "stopped",
    own.uncertain && "outcome unknown",
    own.exitless && own.declared && "no exit",
  ].filter((cue) => typeof cue === "string");
}

/**
 * Draw the declared lifecycle table with every ticket on its current state. Nodes, exits and
 * stops come only from the table, so a state it gives no exit is drawn exitless and no exit
 * appears that the table lacks. A ticket sits where its feed kind and stop name say.
 * @returns Null when the feed carries no table.
 */
function graph(feed: Feed, now: number): Graph | null {
  const table = feed.lifecycle;
  if (!table) return null;
  const steps = feed.pipelineSteps ?? pipelineSteps;
  const before = ["planned", "queued"].map((id) =>
    node(id, id, {
      actor: feed.stages?.find((stage) => stage.id === id)?.actor ?? null,
      declared: false,
    }),
  );
  const columns = Object.entries(table).map(([kind, entry]) =>
    column(kind, entry, !PATH.includes(kind)),
  );
  const path = [
    ...before.map((own): GraphColumn => ({ ...own, stops: [] })),
    ...PATH.flatMap((kind) => columns.find((entry) => entry.id === kind) ?? []),
  ];
  // A state with stops is as urgent as its most urgent stop.
  const soonest = (entry: GraphColumn) =>
    Math.min(
      entry.held ? entry.urgency : Infinity,
      ...entry.stops.map((s) => s.urgency),
    );
  const stops = columns
    .filter((entry) => entry.held || entry.stops.length)
    .sort((a, b) => soonest(a) - soonest(b));
  const nodes = new Map(
    [...path, ...stops].flatMap((entry) =>
      [entry, ...entry.stops].map((own): [string, Placed] => [own.id, own]),
    ),
  );
  const banners: Banner[] = [];
  for (const task of feed.tasks) {
    const kind = task.kind ?? task.stage;
    const at = nodes.get(`${kind}/${task.stopName}`) ?? nodes.get(String(kind));
    if (!at) continue;
    const found = marker(task, steps, now);
    at.markers.push(found);
    if (at.held) banners.push(banner(task, at, found));
  }
  for (const own of nodes.values()) look(own);
  return {
    waiting: feed.tasks.filter((task) => task.actor === "operator").length,
    path,
    stops,
    banners: banners.sort((a, b) => a.urgency - b.urgency),
  };
}

function nextLabel(active: Shown | undefined, total: number): string {
  // Older feeds carry the attempt only on a pending review record.
  const attempt = active?.attempt ?? active?.evidence?.review?.attempt;
  if (active)
    return `${active.id}, ${active.status}${attempt ? ` · attempt ${attempt}` : ""}`.toUpperCase();
  return total ? "EVERY TICKET LANDED" : "NO TICKETS";
}

/**
 * Turn two consecutive status polls into what the page shows. Transitions come from diffing
 * polls, so a ticket that lands keeps its builder row for one poll while its packet travels.
 * @param prev The previous poll, or null on the first one, which replays no transitions.
 * @param now Epoch milliseconds used to age the observation.
 */
export function derive(
  prev: Feed | null,
  raw: Feed,
  now: number,
  events: DashboardEvent[] = [],
): View {
  const next = settle(raw);
  const tasks = next.tasks;
  const earlier = settle(prev ?? raw).tasks;
  const before = new Map(earlier.map((t) => [t.id, t.status]));
  // A review record that disappears without a landing is a rejection. The feed's own "blocked"
  // lasts about 2 s, shorter than a poll, so the status alone misses it.
  const reviewed = new Set(
    earlier.filter((t) => t.evidence?.review).map((t) => t.id),
  );
  const rejected = tasks.find(
    (t) => t.status !== "accepted" && !t.evidence?.review && reviewed.has(t.id),
  )?.id;
  const became = (status: Status) =>
    tasks.find((t) => t.status === status && before.get(t.id) !== status)?.id;
  const rows = tasks
    .filter((t) => (before.get(t.id) ?? t.status) !== "accepted")
    .slice(0, ROWS);
  const rowOf = (id: string | undefined) =>
    rows.findIndex((t) => t.id === id) + 1;
  const main = tasks
    .filter((t) => t.status === "accepted")
    .slice(-MAIN_DOTS)
    .reverse();
  const pending = tasks.filter((t) => t.status !== "accepted");
  const idle = tasks.filter((t) => t.status === "idle");
  const start = Math.max(
    0,
    Math.min(
      (pending[0] ? tasks.indexOf(pending[0]) : tasks.length) - 4,
      tasks.length - QUEUE_DOTS,
    ),
  );
  const landing = became("accepted");
  const label = nextLabel(pending[0], tasks.length);
  // A blocked ticket that resumes was handed back by the foreman, same as a first brief.
  const started = tasks.find(
    (t) =>
      t.status === "working" &&
      ["queued", "blocked"].includes(before.get(t.id) ?? ""),
  )?.id;
  const blocked = rejected ?? became("blocked");
  const stages = next.pipelineSteps ?? pipelineSteps;
  const tickets = tasks.map((task) => ticket(task, stages));
  const count = counts(tasks);
  return {
    state: !next.fresh ? "stale" : next.enabled ? "live" : "paused",
    automations: next.automations ?? [],
    project: next.project.toUpperCase(),
    target: cut(next.target, 24),
    observed: observed(next, now),
    tally: tally(count),
    counts: count,
    tickets,
    pipelineSteps: stages,
    graph: graph(next, now),
    news: events.map((event) => ({
      at: event.at,
      tone:
        event.action === "accepted"
          ? "success"
          : ["rejected", "blocked", "escalated"].includes(event.action)
            ? "danger"
            : "info",
      title: `${event.ticket} ${event.action}`,
      text: noticeText(event),
    })),
    head: main[0]?.revision?.slice(0, 7) ?? "nothing landed yet",
    next: label,
    reviewing: next.fresh && pending[0]?.evidence?.review?.pending === true,
    reviewFinished:
      next.fresh &&
      earlier.some(
        (task) =>
          task.evidence?.review?.pending &&
          (task.id === landing || task.id === rejected),
      )
        ? landing
          ? "passed"
          : "failed"
        : null,
    waiting: idle[0] ? `${idle[0].id} · idle` : "",
    slots: idle.length,
    builders: pad(rows, ROWS).map(cell),
    main: pad(main, MAIN_DOTS).map((task, i) => ({
      on: !!task,
      last: i === 0 && !!task,
      id: task?.id ?? "",
      label: task ? describe(task) : "",
      href: cell(task).href,
    })),
    queue: pad(tasks.slice(start), QUEUE_DOTS)
      .map(cell)
      // neighbours with the same status share one tag: the dots sit closer than "working" is wide
      .map((c, i, cells) => ({
        ...c,
        tag:
          QUIET.includes(c.status) || cells[i - 1]?.status === c.status
            ? ""
            : c.status,
      })),
    coming: pad(pending, COMING_ROWS).map((task, row) =>
      ticketRow(task, row, stages),
    ),
    startRow: rowOf(started),
    landed: !!landing,
    reviewed: !!tasks.find((t) => t.id === landing)?.evidence?.review,
    outRow: rowOf(landing),
    backRow: rowOf(blocked),
  };
}
