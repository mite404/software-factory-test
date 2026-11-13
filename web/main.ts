import { derive, type Feed, type View } from "./derive";

const POLL_MS = 5000;
// Must match the landing and return timelines in style.css.
const LANDING_MS = 5800;
const RETURN_MS = 2800;
const BRIEF_MS = 1200;
const REVIEW_MS = 4800;
const GATE_MS = 5000;
const REPORT_MS = 7000;
const DEMO = new URLSearchParams(location.search).has("demo");

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
const queue = all(".q");
const coming = all(".coming");
// Each ticket row gets its own copy of the stage chips so they can be lit per ticket.
for (const row of coming) {
  const chips = one("#steps").cloneNode(true) as Element;
  chips.removeAttribute("id");
  const own = chips.cloneNode(false) as Element; // filled with the ticket's own steps
  own.classList.add("own");
  row.append(chips, own);
}

const DEMO_STEPS = [
  ["add steps to queue entry", "pass steps through feed", "render step chips"],
  ["rerun failing tests since green", "bisect flaky suite"],
  ["scaffold route", "wire loader", "empty state", "e2e happy path"],
  ["reproduce in e2e", "guard shared parser", "regression test"],
];

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
    target: "main",
    observedAt: new Date().toISOString(),
    enabled: true,
    fresh: true,
    tasks: Array.from({ length: 9 }, (_, i) => ({
      id: `feature-0${i + 1}-ticket1`,
      title: `Sample ticket ${i + 1}`,
      status: i < done ? "accepted" : i > done ? "queued" : phases[step % 3]!,
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

// A landing without a recorded cold review runs straight along the gate-to-main wire.
function land(reviewed: boolean) {
  stage.classList.toggle("direct", !reviewed);
  cycle(stage, "landing", LANDING_MS);
}

function paintBuilders(view: View) {
  builders.forEach((row, i) => {
    const cell = view.builders[i]!;
    row.dataset.status = cell.status;
    write(row, ".id", cell.id);
    row.dataset.tip = cell.label;
    if (cell.href) one(".card", row).setAttribute("href", cell.href);
    else one(".card", row).removeAttribute("href");
  });
}

// Draw a COMING row's own step chips by cloning one stage chip and one arrow from the row.
function paintSteps(row: Element, chips: View["coming"][number]["chips"]) {
  one(".chips:not(.own)", row).toggleAttribute("hidden", chips.length > 0);
  one(".own", row).replaceChildren(
    ...chips.flatMap((chip, n) => {
      const node = one(".chip", row).cloneNode(true) as SVGElement;
      delete node.dataset.s;
      one("rect", node).setAttribute("x", `${chip.x}`);
      one("rect", node).setAttribute("width", `${chip.width}`);
      one("text", node).setAttribute("x", `${chip.x + chip.width / 2}`);
      one("text", node).textContent = chip.text;
      if (!n) return [node];
      const arrow = one(".arrow", row).cloneNode() as Element;
      arrow.setAttribute("d", `M${chip.x - 18} 0 H${chip.x - 2}`);
      return [arrow, node];
    }),
  );
}

function paintTickets(view: View) {
  dots.forEach((dot, i) => {
    const cell = view.main[i]!;
    dot.toggleAttribute("data-on", cell.on);
    dot.classList.toggle("last", cell.last);
    dot.dataset.tip = cell.label;
  });
  queue.forEach((dot, i) => {
    const cell = view.queue[i]!;
    dot.dataset.status = cell.status;
    write(dot, "text", cell.tag);
    dot.dataset.tip = cell.label;
  });
  coming.forEach((row, i) => {
    const cell = view.coming[i]!;
    row.toggleAttribute("hidden", !cell.id);
    write(row, ".id", cell.id);
    write(row, ".title", cell.title);
    row.dataset.status = cell.status;
    paintSteps(row, cell.chips);
    write(row, ".target text", view.target);
    one(".target rect", row).setAttribute(
      "width",
      `${view.target.length * 6.4 + 18}`,
    );
    one(".target text", row).setAttribute(
      "x",
      `${1080 + view.target.length * 3.2}`,
    );
    row
      .querySelectorAll<SVGElement>(".chips:not(.own) .chip:not(.target)")
      .forEach((chip, n) => {
        chip.dataset.s = cell.steps[n]!;
      });
  });
  one("#idle-queue").toggleAttribute("hidden", !!view.coming[1]!.id);
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

function render(view: View) {
  stage.dataset.state = view.state;
  write(document, "#state", DEMO ? "DEMO" : view.state.toUpperCase());
  write(document, "#project", view.project);
  write(document, "#lane", view.target);
  write(document, "#observed", view.observed);
  write(document, "#tally", view.tally);
  write(document, "#head", view.head);
  write(document, "#next", view.next);
  write(document, "#waiting", view.waiting);
  slots.forEach((slot, i) => slot.toggleAttribute("data-on", i < view.slots));
  paintBuilders(view);
  paintTickets(view);
  animate(view);
}

let previous: Feed | null = null;
let tick = 0;

async function poll() {
  try {
    // Feed validated by factory/dashboard.ts before it is served.
    const feed: Feed = DEMO
      ? demoFeed(tick++)
      : await fetch("/api/status").then((response) => {
          if (!response.ok) throw new Error(`Status ${response.status}`);
          return response.json();
        });
    render(derive(previous, feed, Date.now()));
    previous = feed;
  } catch {
    stage.dataset.state = "offline";
    write(document, "#state", "OFFLINE");
    write(document, "#observed", "status service unreachable");
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

one("#play").addEventListener("click", () => {
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
  setTimeout(() => cycle(one(".out.r1"), "go", LANDING_MS), BRIEF_MS);
  let at = 0;
  for (const [element, name, ms] of steps) {
    setTimeout(() => cycle(element, name, ms), at);
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
setInterval(() => void poll(), POLL_MS);
