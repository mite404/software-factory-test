import type { DashboardSnapshot } from "../factory/dashboard";

// evidence is added per task by GET /api/status but is not part of the exported snapshot type.
// evidence.review is the cold review record bound to the task's current revision; null means none
// is recorded, which on an accepted task is not proof that review was skipped.
export type Task = DashboardSnapshot["tasks"][number] & {
  evidence?: { review: { pending?: boolean; attempt?: number } | null };
};

// One step chip of a COMING row, placed in SVG units.
type Chip = { text: string; x: number; width: number };

// What GET /api/status returns: the snapshot plus freshness, or an empty feed before first run.
export type Feed = {
  project: string;
  target: string; // branch the integrator fast-forwards onto
  observedAt: string | null;
  enabled: boolean;
  fresh: boolean;
  tasks: Task[];
};

// One ticket as the page shows it. Missing tickets pad fixed-size rows as "empty".
type Cell = {
  status: Task["status"] | "empty";
  id: string;
  label: string;
  href: string | null;
};

// Everything the page paints, fully resolved so main.ts only copies values into the SVG.
export type View = {
  state: "live" | "paused" | "stale";
  project: string;
  target: string; // merge target branch, cut to fit its pill
  observed: string;
  tally: string;
  head: string;
  next: string;
  reviewing: boolean; // a fresh pending review, including the first and repeated polls
  reviewFinished: "passed" | "failed" | null; // release once on an observed review outcome
  waiting: string;
  slots: number; // lit submission slots: idle builders whose work is not accepted yet
  builders: Cell[]; // 4 rows: tickets that had not landed one poll ago
  main: { on: boolean; last: boolean; label: string; href: string | null }[]; // 7 dots, newest first, beside the integrator
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
const STEPS = 7; // worktree, setup, builder thread, report.json, gate, cold review, ff-merge
// ponytail: the feed has one status per ticket, so stages are inferred from it. A builder
// thread implies worktree and setup; an idle one has reported. Use per-stage evidence when
// /api/status carries it.
const REACHED: Partial<Record<Cell["status"], number>> = {
  working: 3,
  idle: 4,
  blocked: 3,
};

function pad<T>(items: T[], length: number): (T | undefined)[] {
  return Array.from({ length }, (_, i) => items[i]);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describe(task: Task): string {
  const revision = task.revision ? ` · ${task.revision.slice(0, 7)}` : "";
  // The tooltip is one unwrapped line, so a brief-length title is cut to fit.
  return `${task.id} · ${cut(task.title, 40)} · ${task.status}${revision}`;
}

function cell(task: Task | undefined): Cell {
  if (!task) return { status: "empty", id: "", label: "", href: null };
  return {
    status: task.status,
    id: task.id,
    label: describe(task),
    href: task.thread ? `https://ampcode.com/threads/${task.thread}` : null,
  };
}

// A pending review record is evidence the gate passed and cold review is running.
function steps(status: Cell["status"], reviewing = false): string[] {
  const done = reviewing ? 5 : (REACHED[status] ?? 0);
  const current =
    status === "blocked" && !reviewing ? "fail" : done ? "now" : "";
  return Array.from({ length: STEPS }, (_, i) =>
    i < done ? "done" : i === done ? current : "",
  );
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
  task: Task | undefined,
  row: number,
): View["coming"][number] {
  if (!task)
    return {
      id: "",
      title: "",
      status: "empty",
      steps: steps("empty"),
      chips: [],
    };
  return {
    id: task.id,
    title: cut(task.title, 32),
    status: task.status,
    steps: steps(task.status, task.evidence?.review?.pending === true),
    chips: row ? chips(task.steps) : [],
  };
}

function observed(feed: Feed, now: number): string {
  if (!feed.observedAt) return "no observation yet";
  const seconds = Math.round((now - Date.parse(feed.observedAt)) / 1000);
  return `observed ${Math.max(0, seconds)} s ago`;
}

function tally(feed: Feed): string {
  const count = (status: Task["status"]) =>
    feed.tasks.filter((task) => task.status === status).length;
  const blocked = count("blocked");
  return [
    `${count("accepted")} landed`,
    `${count("queued")} queued`,
    ...(blocked ? [`${blocked} blocked`] : []),
  ].join(" · ");
}

// The feed says "blocked" for a few seconds while a cold review is being dispatched. A pending
// review is work in progress, so it counts as working everywhere on the page.
function settle(feed: Feed): Feed {
  return {
    ...feed,
    tasks: feed.tasks.map((task) =>
      task.evidence?.review?.pending ? { ...task, status: "working" } : task,
    ),
  };
}

function nextLabel(active: Task | undefined, total: number): string {
  // The feed carries the attempt only on a review record, so it shows during cold review.
  const attempt = active?.evidence?.review?.attempt;
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
export function derive(prev: Feed | null, raw: Feed, now: number): View {
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
  const became = (status: Task["status"]) =>
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
  return {
    state: !next.fresh ? "stale" : next.enabled ? "live" : "paused",
    project: next.project.toUpperCase(),
    target: cut(next.target, 24),
    observed: observed(next, now),
    tally: tally(next),
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
    coming: pad(pending, COMING_ROWS).map(ticketRow),
    startRow: rowOf(
      // A blocked ticket that resumes was handed back by the foreman, same as a first brief.
      tasks.find(
        (t) =>
          t.status === "working" &&
          ["queued", "blocked"].includes(before.get(t.id) ?? ""),
      )?.id,
    ),
    landed: !!landing,
    reviewed: !!tasks.find((t) => t.id === landing)?.evidence?.review,
    outRow: rowOf(landing),
    backRow: rowOf(rejected ?? became("blocked")),
  };
}
