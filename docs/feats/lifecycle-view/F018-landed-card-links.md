# F018-landed-card-links

## Status

- Goal: on the kit page, a click anywhere on a landed ticket's hover card opens its thread in
  Amp, and a small arrow beside the revision hash opens its pull request on GitHub.
- Initial priority: P1. Effort: Small.
- Risk: normal; read-only links. A wrong URL built from feed data would be a link to an
  attacker-chosen site, so each URL is built from validated parts only.
- Depends on: F016-kit-page-default. The arrow shows only once F014-lifecycle-stages puts the
  pull request URL in the feed; this ticket does not wait for F014.
- Planned at: `1902ba1a141a2a46cea40f879d855a7cacf3687d`, 2026-11-15. Local only.

## Why this matters

The operator asked for both links on 2026-11-15 and reported that a click on the card no longer
opens the thread, which the previous dashboard did. The card is the place a person looks at a
landed ticket; from there they want the conversation that built it and the change that merged
it.

## Current state

- `Landings` in `web/spec/tickets.tsx` wraps each landed dot in a `span` whose `onClick` calls
  `open(dot.href)`, which is `window.open(href, "_blank", "noreferrer")`. The hover card
  (`Landed`) is rendered inside that span.
- The operator's report, 2026-11-15: in Amp's browser pane a click on the card does nothing. In
  an external browser it opens the thread as a web page. The previous dashboard, which used an
  SVG `<a target="_blank">`, opened the thread in a new Amp desktop window, and that is what the
  operator wants.
- The Foreman confirmed in headless Chromium that a click on the dot and on the card body each
  calls `window.open` with the thread URL, so the handler runs; the difference is a scripted
  open against a real link. A real link is also reachable by keyboard and middle click.
- `Builders` uses the same `onClick` pattern for the working ticket.
- `Landed` prints `{ticket.title} <span>{ticket.revision}</span>`. Nothing links to GitHub.
- The feed has no pull request for a ticket. F014 adds a merge record with the pull request
  number and URL. A factory acceptance is a local fast-forward; the pull request is opened and
  merged by the Foreman afterwards.
- For an accepted ticket `projectTask` in `factory/dashboard.ts` replaces the worker's thread
  and title with the review record's. On 2026-11-15 the live feed gave every landed ticket the
  title "<id> - post-graft review (sent)" and its last reviewer's thread, so the operator saw
  nine landed "reviews" and each card opened a reviewer.

## Approach

Make the links real anchors. Wrap the landed dot's trigger and the card in one
`<a href target="_blank" rel="noreferrer">` to the ticket's thread, with an accessible name that
says which ticket and that it opens the thread. Do the same for the builder spots. Remove the
`open` helper when nothing calls it.

Print the pull request as text, "PR #N", beside the revision in `Landed`, so a landed ticket can be
found by the number the Foreman reports. Next to it, render a second, nested-safe control: a small
arrow link to the pull request, with the accessible name "Open pull request #N on GitHub". HTML
forbids an anchor inside an anchor, so place the arrow as a sibling positioned over the card, or
stop the card being an anchor around it; a click on the arrow must open only the pull request. Show
the arrow only when the feed carries a pull request URL of the form
`https://github.com/<owner>/<repo>/pull/<number>`. Until F014 lands, no ticket has one, so no arrow
shows; "Page placeholders" in `docs/v1-execution.md` lists it.

Fix the feed for landed tickets: an accepted ticket keeps its own title and its worker's thread.
A ticket still in review keeps today's review title and reviewer thread. The landed card then
opens the worker's thread. F011 later adds the reviewer threads as separate fields.

## Scope

- In: `web/spec/tickets.tsx`, `web/spec/tickets.css`, `web/derive.ts` and its test,
  and `web/replay.ts`.
- In: the title and thread of an accepted ticket in `factory/dashboard.ts`, with its test.
- Out: any other feed field, the vendored kit files, and any other card content.
- Preserve: the hover card's appearance apart from the arrow, one card open at a time, and
  thread links elsewhere on the page.

## Steps

1. **Compare the old link**. Read how the page linked a ticket before the kit
   (`git show 586ea64:web/main.ts` and `web/index.html`) and use the same kind of anchor.
2. **Fix the landed feed**. Give an accepted ticket its own title and its worker's thread in
   the feed, with a test on the real fixtures.
3. **Model the two links**. In `web/derive.ts`, give each ticket a thread URL and a pull request
   URL that is null unless the feed value validates, with tests.
4. **Make the card a link**. Replace the scripted open on landed dots and builder spots with
   real anchors.
5. **Add the pull request arrow**. Render the arrow beside the revision when the URL exists, so
   that its click opens only the pull request.
6. **Record replay frames**. Add a landed ticket with a pull request URL and one without to
   `web/replay.ts`.
7. **Check it rendered**. Inspect screenshots and a short recording of hover, card click and
   arrow click, by pointer and by keyboard.

## Test plan

Feed test: after acceptance with a cold review, the ticket's title is its own and its thread is the
worker's; during review both are the reviewer's as today. Model tests: a feed pull request URL on
another host, with extra path, or not HTTPS gives null; a valid one gives the URL and number; a
ticket with no thread gives no thread link. Rendered, on the replay feed: hovering a landed dot
shows the card; a click on the card body and on the dot each opens the thread URL once; a click on
the arrow opens the pull request URL and not the thread; a ticket without a pull request shows no
arrow; Tab reaches both links and Enter opens them; only one card is open while sweeping along the
row. Run the page inside an iframe once to show the links still open.

## Why this approach?

- Without it: opening depends on a script call that some views drop, and a landed ticket has no
  path to the change that merged it.
- This buys: the browser handles the link, so it works wherever links work and is reachable by
  keyboard. Validating the pull request URL in the page model keeps a bad feed value from
  becoming a link.

## Files You'll Touch

| Path                                                | Role       | Contains                                 | Edit or Read |
| --------------------------------------------------- | ---------- | ---------------------------------------- | ------------ |
| `factory/dashboard.ts`, `factory/dashboard.test.ts` | Projection | `projectTask`                            | Edit         |
| `web/derive.ts`, `web/derive.test.ts`               | Page model | `Ticket`, `href`                         | Edit         |
| `web/spec/tickets.tsx`                              | Kit page   | `Landed`, `Landings`, `Builders`, `open` | Edit         |
| `web/spec/tickets.css`                              | Kit page   | Spot and hover card rules                | Edit         |
| `web/replay.ts`                                     | Dev feed   | Recorded frames                          | Edit         |
| `web/spec/components`                               | Vendored   | `HoverCard`                              | Read         |
| `docs/v1-execution.md`                              | Plan       | Page placeholders table                  | Read         |

Build order: reproduction, model, card link, arrow, replay frames, rendered check.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                               | Expected result / action                        |
| ----------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`            | Record the dispatch revision; clean tree.       |
| `git diff --stat 1902ba1..HEAD -- web/`               | Revalidate drift, including F016.               |
| `git diff -- web/ && git diff --cached -- web/`       | Preserve unrelated changes.                     |
| `rg -n "onClick=\{\(\) => open" web/spec/tickets.tsx` | The two scripted opens.                         |
| `bun run web:build`                                   | The page builds.                                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test`                | Passes; CI runners have no global Git identity. |

## Done when

- [ ] A landed ticket shows its own title and opens its worker's thread, not a reviewer's.
- [ ] A click anywhere on a landed card, except the arrow, follows a real `<a target="_blank">`
      to the ticket's thread, as the previous dashboard did.
- [ ] The card shows "PR #N" beside the revision when the feed has a pull request.
- [ ] The arrow beside the revision opens the pull request and shows only when the feed has a
      valid pull request URL.
- [ ] Both links work by keyboard and have accessible names.
- [ ] Screenshots and a recording of the hover, card click and arrow click are inspected and
      named in the report.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

The worker cannot test Amp's desktop app. The Foreman asks the operator to confirm, on the live
portal, that the card opens a thread window in Amp before ticking the first box.
