import type { DashboardEvent } from "../factory/dashboard";
import {
  derive,
  eventBatch,
  eventRows,
  type Feed,
  type FeedTask,
  type View,
} from "./derive";
import { mount } from "./spec/tickets";

const POLL_MS = 5000;
const EVENT_LIMIT = 500;
// Must match the landing and return timelines in style.css.
const LANDING_MS = 5800;
const RETURN_MS = 2800;
const BRIEF_MS = 1200;
const REVIEW_MS = 4800;
const GATE_MS = 5000;
const REPORT_MS = 7000;
const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.has("demo");
document.documentElement.dataset.theme = "spec";

function one(selector: string, root: ParentNode = document): Element {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function all(selector: string): SVGElement[] {
  return [...document.querySelectorAll<SVGElement>(selector)];
}

const stage = all("#stage")[0]!;
const builders = all(".builder");
const slots = all(".slot");
const dots = all(".landed");
const paintKit = mount(stage);
const motion = document.querySelector<HTMLInputElement>("#reduce-motion")!;
const replay = document.querySelector<HTMLButtonElement>("#play")!;
const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
const replayTimers: ReturnType<typeof setTimeout>[] = [];
let manualReduced = false;
let lastView: View | null = null;
let reviewWatch: View["reviewWatch"] = null;
const unread = document.querySelector<HTMLElement>("#status-unread")!;

const DEMO_STEPS = [
  ["add steps to queue entry", "pass steps through feed", "render step chips"],
  ["rerun failing tests since green", "bisect flaky suite"],
  ["scaffold route", "wire loader", "empty state", "e2e happy path"],
  ["reproduce in e2e", "guard shared parser", "regression test"],
];

// Where a sample ticket sits: landed, waiting, blocked, or building with a live activity.
const SAMPLE = {
  accepted: { stage: "accepted", step: 6, activity: null },
  queued: { stage: "queued", step: null, activity: null },
  blocked: { stage: "blocked", step: 3, activity: null },
  working: { stage: "building", step: 3, activity: "working" },
  idle: { stage: "building", step: 4, activity: "idle" },
} satisfies Record<string, Pick<FeedTask, "stage" | "step" | "activity">>;

// Labeled sample feed for ?demo: one ticket at a time works, goes idle, then lands.
function demoFeed(tick: number): Feed {
  const step = tick % 27; // 9 tickets, 3 polls each
  const done = Math.floor(step / 3);
  const phases = [
    "working",
    step === 10 ? "blocked" : "working",
    "idle",
  ] as const;
  return {
    project: "sample data, not a running factory",
    sample: true,
    target: "main",
    observedAt: new Date().toISOString(),
    enabled: true,
    fresh: true,
    stages: [
      { id: "queued", actor: "computer", status: "queued" },
      { id: "building", actor: "model", status: "unknown" },
      { id: "blocked", actor: "foreman", status: "blocked" },
      { id: "accepted", actor: "foreman", status: "accepted" },
    ],
    tasks: Array.from({ length: 9 }, (_, i) => ({
      id: `feature-0${i + 1}-ticket1`,
      title: `Sample ticket ${i + 1}`,
      ...SAMPLE[
        i < done ? "accepted" : i > done ? "queued" : phases[step % 3]!
      ],
      thread: null,
      steps: DEMO_STEPS[i % DEMO_STEPS.length]!,
      revision: i < done ? `${i + 1}`.repeat(40) : null,
      evidence: { review: [null, {}][i % 2]! }, // every other sample landing skips cold review
    })),
  };
}

function write(root: ParentNode, selector: string, text: string) {
  one(selector, root).textContent = text;
}

function cycle(element: Element, name: string, ms: number) {
  element.classList.remove(name);
  element.getBoundingClientRect(); // reflow, so a repeated cycle restarts its animation
  element.classList.add(name);
  setTimeout(() => element.classList.remove(name), ms);
}

function stopMotion() {
  replayTimers.splice(0).forEach((timer) => clearTimeout(timer));
  stage.classList.remove(
    "landing",
    "review-passed",
    "review-failed",
    "reporting",
    "reviewing",
    "passing",
    "gating",
  );
  stage.querySelectorAll(".go").forEach((el) => el.classList.remove("go"));
}

function syncMotion() {
  const reduced = systemMotion.matches || manualReduced;
  motion.checked = reduced;
  motion.disabled = systemMotion.matches;
  replay.disabled = reduced;
  document.documentElement.toggleAttribute("data-reduce-motion", reduced);
  if (reduced) stopMotion();
}

// A landing without a recorded cold review runs straight along the gate-to-main wire.
function land(reviewed: boolean) {
  stage.classList.toggle("direct", !reviewed);
  cycle(stage, "landing", LANDING_MS);
}

// An SVG link without an href is neither clickable nor focusable.
function link(anchor: Element, href: string | null) {
  if (href) anchor.setAttribute("href", href);
  else anchor.removeAttribute("href");
}

function paintBuilders(view: View) {
  builders.forEach((row, i) => {
    const cell = view.builders[i]!;
    row.dataset.status = cell.status;
    write(
      row,
      ".id",
      cell.id.length > 30 ? `${cell.id.slice(0, 29)}…` : cell.id,
    );
    row.dataset.tip = cell.label;
    link(one(".card", row), cell.href);
  });
}

function paintMain(view: View) {
  dots.forEach((dot, i) => {
    const cell = view.main[i]!;
    dot.toggleAttribute("data-on", cell.on);
    dot.classList.toggle("last", cell.last);
    dot.dataset.tip = cell.label;
    link(dot.parentElement!, cell.href);
  });
}

function animate(view: View) {
  if (view.landed) land(view.reviewed);
  const packets = [
    ["brief", view.startRow, BRIEF_MS],
    ["out", view.outRow, LANDING_MS],
    ["back", view.backRow, RETURN_MS],
  ] as const;
  for (const [kind, row, ms] of packets)
    if (row) cycle(one(`.${kind}.r${row}`), "go", ms);
}

function paintMotion(view: View) {
  if (["stale", "offline"].includes(view.state)) {
    stopMotion();
    return;
  }
  if (replay.disabled) return;
  if (view.reviewFinished)
    cycle(stage, `review-${view.reviewFinished}`, RETURN_MS + 240);
  else animate(view);
}

function render(view: View, events: DashboardEvent[], eventStatus: string) {
  lastView = view;
  reviewWatch = view.reviewWatch;
  stage.removeAttribute("hidden");
  unread.hidden = true;
  stage.dataset.state = view.state;
  stage.toggleAttribute("data-reviewing", view.reviewing);
  write(document, "#state", DEMO ? "DEMO" : view.state.toUpperCase());
  write(document, "#project", view.project);
  write(document, "#lane", view.target);
  write(document, "#observed", view.observed);
  write(document, "#tally", view.tally);
  write(document, "#head", view.head);
  write(document, "#waiting", view.waiting);
  slots.forEach((slot, i) => slot.toggleAttribute("data-on", i < view.slots));
  paintBuilders(view);
  paintMain(view);
  paintKit(view, eventRows(events), eventStatus);
  paintMotion(view);
}

let previous: Feed | null = null;
let tick = Number(PARAMS.get("tick")) || 0; // ?demo&tick=7 starts the sample feed at a later poll
const events: DashboardEvent[] = [];
let caughtUp = false;

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function pollEvents() {
  let received: DashboardEvent[] | null = null;
  let status = "Event service unavailable. Showing retained rows.";
  try {
    const last = events.at(-1) ?? { id: 0 };
    const body = await get<{ events: DashboardEvent[]; durable: string }>(
      `/api/events?after=${last.id}&limit=${EVENT_LIMIT}`,
    );
    events.push(...body.events);
    received = body.events;
    status = body.durable === "missing" ? "No event storage yet" : "available";
  } catch {
    // Retain the cursor and catch-up state when the event service fails.
  }
  const batch = eventBatch(caughtUp, received, EVENT_LIMIT);
  caughtUp = batch.caughtUp;
  return { received: batch.news, status };
}

function eventStatus(feed: Feed, status: string) {
  return feed.sample && status === "available"
    ? "Illustrative event rows · not live"
    : status;
}

function renderOffline() {
  const message = "Status service unreachable.";
  if (!lastView) {
    unread.textContent = `${message} No status has been received.`;
    return;
  }
  render(
    {
      ...lastView,
      state: "offline",
      observed: `${message} Showing last known state.`,
      reviewing: false,
      reviewWatch: null,
      news: [],
    },
    events,
    "Status service unreachable · retained rows",
  );
}

async function poll() {
  try {
    // Feed validated by factory/dashboard.ts before it is served.
    const feed: Feed = DEMO ? demoFeed(tick++) : await get<Feed>("/api/status");
    const log = DEMO
      ? { received: [], status: "Sample data has no recorded events" }
      : await pollEvents();
    render(
      derive(previous, feed, Date.now(), log.received, reviewWatch),
      events,
      eventStatus(feed, log.status),
    );
    previous = feed;
  } catch {
    renderOffline();
    previous = null;
  } finally {
    setTimeout(() => void poll(), POLL_MS);
  }
}

// Review aid: replays a hand-off, a landing, a blocked return, placeholder reports to the foreman,
// a cold review with findings, then a green and a red full gate. The feed reports none of the last
// four. Feed state is untouched.
// Each time the mist starts, each puff gets a new height on the door's centre line and a new drift.
function scatter(event: Event) {
  const puff = event.target as SVGElement;
  const between = (low: number, high: number) =>
    low + Math.random() * (high - low);
  puff.setAttribute("cy", between(178, 208).toFixed(1));
  puff.style.setProperty("--dx", `${between(-22, 22).toFixed(1)}px`);
  puff.style.setProperty("--dy", `${between(-14, 14).toFixed(1)}px`);
}
one(".mist").addEventListener("animationstart", scatter);

motion.addEventListener("change", () => {
  manualReduced = motion.checked;
  syncMotion();
});
systemMotion.addEventListener("change", syncMotion);
syncMotion();

replay.addEventListener("click", () => {
  stopMotion();
  const steps = [
    [one(".brief.r1"), "go", BRIEF_MS],
    [stage, "landing", LANDING_MS], // through cold review
    [one(".back.r1"), "go", RETURN_MS],
    [stage, "reporting", REPORT_MS],
    [stage, "reviewing", REVIEW_MS],
    [stage, "passing", GATE_MS],
    [stage, "gating", GATE_MS],
  ] as const;
  stage.classList.remove("direct");
  replayTimers.push(
    setTimeout(() => cycle(one(".out.r1"), "go", LANDING_MS), BRIEF_MS),
  );
  let at = 0;
  for (const [element, name, ms] of steps) {
    replayTimers.push(setTimeout(() => cycle(element, name, ms), at));
    at += ms;
  }
});

// Hover tooltip: one box that follows the pointer over anything carrying data-tip.
const tip = document.querySelector<HTMLElement>("#tip")!;
document.addEventListener("pointermove", (event) => {
  const text =
    (event.target as Element).closest<SVGElement>("[data-tip]")?.dataset.tip ??
    "";
  tip.hidden = !text;
  tip.textContent = text;
  const left = Math.min(event.clientX + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.translate = `${left}px ${event.clientY + 18}px`;
});

void poll();
