import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "@ui-sdk/react/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { BarGraph } from "@/components/ui/bar-graph";
import { Device } from "@/components/ui/device";
import { Display } from "@/components/ui/display";
import { Hardware } from "@/components/ui/hardware";
import { HoverCard } from "@/components/ui/hover-card";
import { PageWheel } from "@/components/ui/page-wheel";
import { ItemList, type Column } from "@/components/ui/item-list";
import { Lcd, LcdDigits } from "@/components/ui/lcd";
import { Toasts, notify } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import type { Ticket, View } from "../derive";
import "./kit.css";
import "./tickets.css";

type Note = View["news"][number] & { at: string };
// Where the diagram's builders and landed commits sit, as CSS boxes over the SVG.
type Spots = { builders: CSSProperties[]; main: CSSProperties[] };
type Choose = (id: string | null) => void;

// The kit's orange hue, pulled inside sRGB: its own 0.31 chroma clips to pure red on screen.
const KEY = { l: 0.67, c: 0.18, h: 48 };
const CHECKS = ["test", "lint", "typecheck", "format", "fallow", "diff-check"];
const STAGES = 7;
const PAGE = 4; // COMING rows per page
const LOG = 50; // notifications kept for the list
const RULE_Y = 535; // just above the ACTIVE rule in web/index.html
const LIFT = 64; // how far this skin raises the return wire, in SVG units
// A stage's state as a badge tone. "now" has no tone in the kit; tickets.css lights it in the key color.
const TONE = { done: "success", fail: "danger" } as const;
// A failed stage also says so in print, so it does not rest on colour alone.
const NOTE: Record<string, string> = { fail: " · fail" };
const TOAST = { success: "success", danger: "error", info: "info" } as const;
// The feed says "accepted"; the page has always said "landed".
const WORD: Record<string, string> = { accepted: "landed" };
const NONE: Ticket = {
  status: "unknown",
  id: "",
  label: "",
  href: null,
  stage: 0,
  title: "",
  steps: [],
  plan: [],
  revision: "",
  review: "none",
  attempt: null,
};
const COLUMNS: Column<Ticket>[] = [
  { key: "id", label: "Ticket", width: "250px", render: (row) => row.id },
  {
    key: "plan",
    label: "Plan",
    width: "minmax(0, 1fr)",
    render: (row) => row.plan.join(" → "),
  },
  {
    key: "status",
    label: "Status",
    width: "64px",
    align: "end",
    render: (row) => word(row),
  },
];

const word = (ticket: Ticket) => WORD[ticket.status] ?? ticket.status;
const line = (i: number) => ({ "--i": i }) as CSSProperties;

function open(href: string | null) {
  if (href) window.open(href, "_blank", "noreferrer");
}

// The dark screen: one ticket, and how far every ticket in the queue window has got.
function Screen({
  ticket,
  status,
  view,
}: {
  ticket: Ticket;
  status: string;
  view: View;
}) {
  const cells = view.queue.filter((cell) => cell.id);
  return (
    <Display aspect="auto">
      <div data-dash-view>
        <div data-dash-detail data-ticket={ticket.status}>
          <span data-status>{status}</span>
          <strong>{ticket.id || "no ticket"}</strong>
          <p>{ticket.title}</p>
          <dl>
            <div>
              <dt>Stages done</dt>
              <dd>
                {ticket.stage} / {STAGES}
              </dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>{ticket.attempt ?? "-"}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>{view.target}</dd>
            </div>
          </dl>
        </div>
        <figure>
          <BarGraph
            label="Stages finished by each ticket in the queue"
            values={cells.map((cell) => cell.stage / STAGES)}
            segments={STAGES}
          />
          <figcaption>stages done · one bar per ticket</figcaption>
        </figure>
      </div>
    </Display>
  );
}

function Stages({
  ticket,
  stages,
  target,
}: {
  ticket: Ticket;
  stages: string[];
  target: string;
}) {
  return (
    <ol data-stages>
      {stages.map((stage, i) => (
        <li key={stage} data-s={ticket.steps[i]}>
          <Badge tone={TONE[ticket.steps[i] as keyof typeof TONE]}>
            {stage}
            {NOTE[ticket.steps[i]!]}
          </Badge>
        </li>
      ))}
      <li>
        <Badge>{target}</Badge>
      </li>
    </ol>
  );
}

function Thread({ href }: { href: string | null }) {
  if (!href) return "none";
  return (
    <a href={href} target="_blank" rel="noreferrer">
      open
    </a>
  );
}

// The gray LCD: what the feed records about one ticket, beside the gate's fixed rules.
function Sheet({ ticket }: { ticket: Ticket }) {
  return (
    <Lcd size="lg" tag={`ticket sheet · ${ticket.id}`}>
      <dl>
        <div>
          <dt>Plan · {ticket.plan.length} steps</dt>
          {ticket.plan.map((step, i) => (
            <dd key={i}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              {step}
            </dd>
          ))}
        </div>
        <div data-on={ticket.status === "idle" || undefined}>
          <dt>Gate · 10 min cap</dt>
          <dd>
            <span>1</span>candidate from report.json: revision = HEAD, tree
            clean, every path in scope
          </dd>
          <dd data-checks>
            <span>2</span>verify:{" "}
            {CHECKS.map((check, i) => (
              <i key={check} style={line(i)}>
                {check}
              </i>
            ))}
          </dd>
          <dd>
            <span>3</span>unchanged: HEAD still the candidate, tree still clean
          </dd>
          <dd>
            <span />
            check ticks are illustrative, not live
          </dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>
            <span>review</span>
            {ticket.review}
          </dd>
          <dd>
            <span>revision</span>
            {ticket.revision || "not landed"}
          </dd>
          <dd>
            <span>thread</span>
            <Thread href={ticket.href} />
          </dd>
        </div>
      </dl>
      <p>
        <b>pass</b> → cold review · <b>fail</b> → same builder with the log ·
        2nd fail → escalated
      </p>
    </Lcd>
  );
}

// A lit banner for the two things that should stop the reader: a feed that is not live, a block.
function Warning({ view, active }: { view: View; active: Ticket }) {
  if (view.state !== "live")
    return (
      <Alert tone="warning" title={`feed ${view.state}`}>
        {view.observed}
      </Alert>
    );
  if (active.status !== "blocked") return null;
  return (
    <Alert tone="danger" title={`${active.id} blocked`}>
      Stopped with {active.stage} of {STAGES} stages done. The feed gives no
      reason.
    </Alert>
  );
}

function Search({
  tickets,
  chosen,
  choose,
}: {
  tickets: Ticket[];
  chosen: string | null;
  choose: Choose;
}) {
  return (
    <Combobox
      data-kit="field"
      value={chosen}
      onValueChange={(next) => choose(next ? String(next) : null)}
    >
      <ComboboxLabel data-kit="label">Find ticket</ComboboxLabel>
      <div data-kit="input-group">
        <ComboboxInput data-kit="input" placeholder="Search…" />
        <ComboboxTrigger data-kit="input-addon" aria-label="Show tickets">
          ▾
        </ComboboxTrigger>
      </div>
      <ComboboxContent data-kit="popup" data-screen align="start">
        <ComboboxEmpty data-kit="empty">No matches.</ComboboxEmpty>
        <ComboboxList>
          {tickets.map((ticket) => (
            <ComboboxItem
              key={ticket.id}
              value={ticket.id}
              label={ticket.id}
              keywords={[ticket.title, word(ticket)]}
              data-kit="option"
            >
              {ticket.id}
              <small>{word(ticket)}</small>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// Every notification since the page opened, newest first. Toasts show each one as it happens.
function Notices({ log }: { log: Note[] }) {
  return (
    <Popover>
      <PopoverTrigger
        data-kit="button"
        data-tone="secondary"
        aria-label={`${log.length} notifications`}
      >
        Notices · {log.length}
      </PopoverTrigger>
      <PopoverContent
        data-kit="popover"
        side="bottom"
        align="end"
        sideOffset={14}
      >
        {/* The surface paints the screen; only the list inside it scrolls, so the screen stays. */}
        <div data-kit="popover-surface" data-notices>
          <div data-scroll tabIndex={0} role="group" aria-label="Notices">
            {log.map((note, i) => (
              <Alert
                key={log.length - i}
                tone={note.tone}
                title={`${note.at} · ${note.title}`}
              >
                {note.text}
              </Alert>
            ))}
            {!log.length && <p>Nothing has changed since this page opened.</p>}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Bar({
  view,
  chosen,
  choose,
  log,
}: {
  view: View;
  chosen: string | null;
  choose: Choose;
  log: Note[];
}) {
  return (
    <div data-bar>
      {chosen && (
        <button
          type="button"
          data-kit="button"
          data-tone="primary"
          onClick={() => choose(null)}
        >
          Follow active
        </button>
      )}
      <Search tickets={view.tickets} chosen={chosen} choose={choose} />
      <Notices log={log} />
    </div>
  );
}

function Active({
  view,
  stages,
  shown,
  live,
}: {
  view: View;
  stages: string[];
  shown: Ticket;
  live: boolean;
}) {
  return (
    <section data-section data-area="active">
      <h2>
        {live ? "Active" : "Inspecting"}
        <Badge tone="success">done</Badge>
        <span data-s="now">
          <Badge>now</Badge>
        </span>
      </h2>
      <Screen
        ticket={shown}
        status={live ? view.next : `${shown.id}, ${word(shown)}`}
        view={view}
      />
      <Stages ticket={shown} stages={stages} target={view.target} />
      <Sheet ticket={shown} />
    </section>
  );
}

// The tickets that have not landed, a page at a time. A row can be chosen to inspect it above.
function Coming({
  pending,
  shown,
  choose,
}: {
  pending: Ticket[];
  shown: Ticket;
  choose: Choose;
}) {
  const [page, setPage] = useState(1);
  // A page past the end, after tickets land, reads as the last page.
  const pages = Math.max(1, Math.ceil(pending.length / PAGE));
  const at = Math.min(page, pages);
  return (
    <section data-section data-area="coming">
      <h2>Coming · in order · {pending.length}</h2>
      {pending.length ? (
        <ItemList<Ticket>
          label="Tickets in order"
          rows={pending.slice((at - 1) * PAGE, at * PAGE)}
          rowKey={(row) => row.id}
          value={shown.id}
          onValueChange={choose}
          columns={COLUMNS}
        />
      ) : (
        <p>nothing pending</p>
      )}
      <PageWheel
        label="Coming tickets, page"
        pageCount={pages}
        page={at}
        onPageChange={setPage}
      />
    </section>
  );
}

function Everything({ view }: { view: View }) {
  return (
    <section data-section data-area="queue">
      <h2>All tickets</h2>
      <div data-counts>
        {Object.entries(view.counts).map(([name, count]) => (
          <Lcd key={name} size="sm" tag={name}>
            <LcdDigits value={String(count).padStart(2, "0")} />
          </Lcd>
        ))}
      </div>
      <small>read-only · one poll every 5 s</small>
    </section>
  );
}

// What the feed knows about a landed ticket, printed on the hover card.
function Landed({ ticket, target }: { ticket: Ticket; target: string }) {
  return (
    <>
      <strong style={line(0)}>
        {ticket.title} <span>{ticket.revision}</span>
      </strong>
      <small style={line(1)}>
        {ticket.id} · landed on {target}
      </small>
      <dl style={line(2)}>
        <div>
          <dt>Cold review</dt>
          <dd>{ticket.review}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{ticket.attempt ?? "-"}</dd>
        </div>
      </dl>
      <ol style={line(3)}>
        {ticket.plan.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <small style={line(4)}>
        {ticket.href ? "click to open its thread" : "no thread recorded"}
      </small>
    </>
  );
}

// Invisible triggers over the diagram: the kit's tooltip on each builder, its hover card on each
// landed commit. A click still opens the ticket's thread, as the SVG link under it did.
// A trigger is keyed by its place, not its ticket: tickets shift along the row as they land, and a
// trigger that moved out from under a still pointer would leave its card open.
function Builders({ view, spots }: { view: View; spots: Spots }) {
  return view.builders.map(
    (cell, i) =>
      cell.id && (
        <span
          key={i}
          data-spot
          style={spots.builders[i]}
          onClick={() => open(cell.href)}
        >
          <Tooltip label={cell.label}>
            <span />
          </Tooltip>
        </span>
      ),
  );
}

function Landings({ view, spots }: { view: View; spots: Spots }) {
  // The one dot whose card is out, so a sweep along the row never shows two cards.
  const [out, setOut] = useState(-1);
  return view.main.map((dot, i) => {
    const ticket = view.tickets.find((t) => t.id === dot.id);
    return (
      ticket && (
        <span
          key={i}
          data-spot
          style={spots.main[i]}
          onClick={() => open(dot.href)}
        >
          <HoverCard
            trigger={<span />}
            triggerKit="spot"
            variant="ticket"
            open={out === i}
            onOpenChange={(open) =>
              setOut((now) => (open ? i : now === i ? -1 : now))
            }
          >
            <Landed ticket={ticket} target={view.target} />
          </HoverCard>
        </span>
      )
    );
  });
}

// The pipeline SVG stays above; this is everything that was below its ACTIVE rule, as one device.
function Tickets({
  view,
  stages,
  log,
  spots,
  over,
}: {
  view: View;
  stages: string[];
  log: Note[];
  spots: Spots;
  over: Element;
}) {
  // The feed picks the active ticket; the reader can pick another to inspect until they let go.
  const [chosen, setChosen] = useState<string | null>(null);
  const pending = view.tickets.filter((t) => t.status !== "accepted");
  const active = pending[0] ?? NONE;
  const shown = view.tickets.find((t) => t.id === chosen) ?? active;
  return (
    <>
      {createPortal(
        <Hardware keyColor={KEY}>
          <Builders view={view} spots={spots} />
          <Landings view={view} spots={spots} />
        </Hardware>,
        over,
      )}
      <Hardware keyColor={KEY}>
        <Device model="SF-1" name="Tickets" on={view.state === "live"}>
          <Bar view={view} chosen={chosen} choose={setChosen} log={log} />
          <Warning view={view} active={active} />
          <Active
            view={view}
            stages={stages}
            shown={shown}
            live={shown === active}
          />
          <Coming pending={pending} shown={shown} choose={setChosen} />
          <Everything view={view} />
        </Device>
        <Toasts />
      </Hardware>
    </>
  );
}

/**
 * Crop the pipeline SVG at its ACTIVE rule and mount the SPEC-01 device under it.
 * @returns The painter main.ts calls with each new view, after it has painted the SVG.
 */
export function mount(stage: SVGElement, stages: string[]) {
  const [x, y, width] = stage.getAttribute("viewBox")!.split(" ").map(Number);
  const height = RULE_Y - LIFT - y!; // SVG units left after the crop
  stage.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  stage.style.aspectRatio = `${width} / ${height}`;
  // Raise the return wire, its packets' paths and its caption here, so the SVG the other skins
  // share stays as drawn. Its packets only run 0 to 100%, so no timing depends on the length.
  for (const wire of stage.querySelectorAll('path[d*="500"]')) {
    const drawn = wire.getAttribute("d")!; // "... V488 Q664 500 652 500 H48 ..."
    const raised = drawn.replace(
      /(?<!\d)(488|495|500|505)(?!\d)/g,
      (y) => `${Number(y) - LIFT}`,
    );
    wire.setAttribute("d", raised);
  }
  stage.querySelector('text[y="527"]')!.setAttribute("y", `${527 - LIFT}`);
  document.documentElement.dataset.kit = "";
  const frame = document.createElement("div");
  frame.id = "kit-stage";
  stage.replaceWith(frame);
  const over = document.createElement("div");
  over.id = "kit-over";
  frame.append(stage, over);
  const host = document.createElement("div");
  host.id = "kit";
  frame.after(host);
  // An SVG element's box as percentages of the stage, so it holds at any width.
  const spot = (element: Element): CSSProperties => {
    const box = element.getBoundingClientRect();
    const all = stage.getBoundingClientRect();
    return {
      left: `${((box.x - all.x) / all.width) * 100}%`,
      top: `${((box.y - all.y) / all.height) * 100}%`,
      width: `${(box.width / all.width) * 100}%`,
      height: `${(box.height / all.height) * 100}%`,
    };
  };
  const spots = (selector: string) =>
    [...stage.querySelectorAll(selector)].map(spot);
  const log: Note[] = [];
  const root = createRoot(host);
  return (view: View) => {
    for (const item of view.news) {
      log.unshift({ ...item, at: new Date().toLocaleTimeString() });
      notify[TOAST[item.tone]](item.title, { description: item.text });
    }
    log.length = Math.min(log.length, LOG);
    root.render(
      <Tickets
        view={view}
        stages={stages}
        log={[...log]}
        spots={{ builders: spots(".builder .card"), main: spots(".landed") }}
        over={over}
      />,
    );
  };
}
