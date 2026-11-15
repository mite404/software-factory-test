# F016-kit-page-default

## Status

- Goal: make the SPEC-01 kit page the dashboard, with no query string, and delete the page
  parts only the other renderer used.
- Initial priority: P1. Effort: Small.
- Risk: normal; a read-only page. The risk is deleting a style or element the kit page still
  uses, so the rendered page is compared before and after.
- Depends on: nothing. F011, F012 and F013 draw on the kit page and follow this ticket.
- Planned at: `0721cb7e7a7f5e3601ae1a32d33504e51ce0956e`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the operator said the page at `?theme=spec&kit` is the dashboard they want and
everything else in that code was a prototype. Today that page is opt-in, and the default URL,
including the factory orb's live portal, shows a different page. Every later page ticket would
have to say which of the two it targets.

## Current state

- PR #34 (`0721cb7`) already removed the eight other skins and `web/prototypes`. `web/themes`
  holds `spec.css` alone, linked from `web/index.html` line 15.
- `web/main.ts` sets `data-theme` from `?theme=<name>` (line 14) and mounts the kit only when
  the theme is `spec` and `kit` is present (lines 41 to 48). With no query the page is the
  unskinned SVG, and `?theme=spec` alone is the skinned SVG without the kit.
- `web/spec/tickets.tsx` mounts the kit below the diagram. It crops the shared SVG at the
  ACTIVE rule and raises the return wire at run time, so the top of the page is still the
  diagram in `web/index.html`.
- `web/spec/components` and `web/spec/lib` are vendored kit files, exempt from Prettier, Fallow
  and one lint rule.
- `?demo` in `web/main.ts` is a labelled sample feed and is not a skin.

## Approach

Mount the kit always and set the `spec` theme always. Remove the `?theme` and `kit` switches.
Then remove what only the unskinned or kit-less page used: the SVG rows below the ACTIVE rule
that the kit replaces, the code in `web/main.ts` that paints them, and their rules in
`web/style.css` and `web/themes/spec.css`. Keep the diagram above the rule, `?demo`, and every
placeholder listed under "Page placeholders" in `docs/v1-execution.md`, each with its label.

Delete only what a search shows is unused, and compare screenshots of the kit page on the
replay feed before and after. A difference is a defect.

## Scope

- In: `web/main.ts`, `web/index.html`, `web/style.css`, `web/themes/spec.css`, `web/AGENTS.md`
  and README text that mentions skins.
- Out: any change to what the kit page shows, the vendored kit files, `factory/`, and wiring
  any placeholder to the feed.
- Preserve: `GET /api/status` as the only request, `?demo`, the replay service, and the kit
  page's appearance at the default and a narrow width.

## Steps

1. **Capture the kit page**. Screenshot `?theme=spec&kit` on the replay feed at the default and
   a narrow width, at the same replay frame, before any edit.
2. **Mount the kit always**. Set the `spec` theme and mount the kit with no query string, and
   remove the two switches.
3. **Remove unused page parts**. Delete SVG elements, painting code and CSS rules that a search
   shows nothing on the kit page uses.
4. **Compare the rendered page**. Screenshot the default URL at the same frame and widths and
   compare with step 1.
5. **Update the page notes**. Describe the single page in `web/AGENTS.md` and remove skin
   instructions.

## Test plan

`bun test web` and `bun run web:build` pass. The before and after screenshots match at both
widths. The default URL with no query renders the kit page, and `?demo` still renders the
sample feed in it. `rg -n 'get\("theme"\)|has\("kit"\)' web` finds nothing. Each placeholder
label in `docs/v1-execution.md` is still on the page.

## Why this approach?

- Without it: the page the operator reads is behind a query string, the live portal shows a
  different page, and each page ticket must name one of two renderers.
- This buys: one page, so F011 to F013 have one place to draw and a reviewer has one page to
  inspect. Deleting by search and comparing screenshots keeps the removal from changing the
  page.

## Files You'll Touch

| Path                                  | Role     | Contains                                        | Edit or Read |
| ------------------------------------- | -------- | ----------------------------------------------- | ------------ |
| `web/main.ts`                         | Page     | Theme and kit switches, painting                | Edit         |
| `web/index.html`, `web/style.css`     | Page     | Diagram, rows the kit replaces                  | Edit         |
| `web/themes/spec.css`                 | Skin     | Rules for the diagram and for the replaced rows | Edit         |
| `web/spec/tickets.tsx`                | Kit page | `mount`, the crop and the raised wire           | Read         |
| `web/spec/components`, `web/spec/lib` | Vendored | Kit components                                  | Read         |
| `web/AGENTS.md`                       | Notes    | How to run and check the page                   | Edit         |

Build order: screenshots, switches, unused parts, comparison, notes.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                         | Expected result / action                        |
| ----------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`      | Record the dispatch revision; clean tree.       |
| `git diff --stat 0721cb7..HEAD -- web/`         | Revalidate drift.                               |
| `git diff -- web/ && git diff --cached -- web/` | Preserve unrelated changes.                     |
| `rg -n 'PARAMS.has\("kit"\)' web/main.ts`       | The kit switch.                                 |
| `ls web/themes`                                 | `spec.css` only.                                |
| `bun run web:build`                             | The page builds.                                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test`          | Passes; CI runners have no global Git identity. |

## Done when

- [x] The default URL shows the kit page; no `theme` or `kit` query is read.
- [x] No element, painting code or style rule remains that only the other renderer used.
- [x] Before and after screenshots of the kit page match at the default and a narrow width.
- [x] Every listed placeholder is still on the page with its label.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

`format:check` does not cover `.tsx` or `web/themes`; run Prettier on those files by hand and
do not reformat the vendored kit files. The active ticket label under the first builder
overlaps its wire in this skin; fix it here if the cause is in a file this ticket edits.
