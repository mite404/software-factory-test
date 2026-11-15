# F017-remove-public-status

## Status

- Goal: remove the five-value public `status` from the dashboard feed once the page reads the
  named stage, so the feed has one answer to "where is this ticket".
- Initial priority: P3. Effort: Small.
- Risk: normal; any reader still using `status` breaks, so the type change must fail the build
  for each one.
- Depends on: F014-lifecycle-stages and F012-lifecycle-graph-view, after which the page reads
  the stage.
- Planned at: `bbad3fcc524fe691fc0d2e3180e648ba31613831`, 2026-11-15. Local only.

## Why this matters

F014 keeps the old statuses beside the new stage so nothing breaks while the page moves over.
Two fields that answer the same question can disagree, and the page already infers stages from
`status` in `web/derive.ts`. Once nothing reads it, keeping it only invites a second
inference.

## Current state

- `DashboardSnapshot` in `factory/dashboard.ts` gives each task a `status`: `working`, `idle`,
  `blocked`, `planned`, `queued`, `accepted` or `unknown`.
- `web/derive.ts` maps `status` to a count of reached stages (`REACHED`) and to the news list.
- `web/spec/tickets.tsx` prints and styles by `ticket.status`.
- `web/replay.ts` records frames with `status`.
- F014 adds `stage` and derives `status` from it.

## Approach

Delete `status` from the snapshot type and its projection. Let `bun run typecheck` list every
reader, and move each one to `stage`. Convert the replay frames to stages. Remove `REACHED`.

## Scope

- In: the feed type and projection, the page model, the kit page, the replay frames, tests and
  the README field list.
- Out: any change to stages or what they mean, and the factory's private run kinds.
- Preserve: what the page shows for every stage.

## Steps

1. **Drop the status field**. Remove `status` from the snapshot type and projection.
2. **Move every reader**. Change each reader the type checker reports to read `stage`.
3. **Convert replay frames**. Rewrite the recorded frames with stages.
4. **Check it rendered**. Compare screenshots of the page on the replay feed before and after.
5. **Document the feed**. Remove `status` from the README field list.

## Test plan

`bun run typecheck` passes with no reader of `status`. `rg -n "\.status\b" web factory/dashboard.ts`
finds nothing that reads the removed field. Feed and model tests cover each stage. Screenshots
of the page on the replay feed match before and after.

## Why this approach?

- Without it: two fields describe one fact, and the page keeps a mapping that can drift.
- This buys: the type checker finds every reader, so nothing is missed by search, and the feed
  carries each fact once.

## Files You'll Touch

| Path                                                | Role       | Contains                 | Edit or Read |
| --------------------------------------------------- | ---------- | ------------------------ | ------------ |
| `factory/dashboard.ts`, `factory/dashboard.test.ts` | Projection | The snapshot type        | Edit         |
| `web/derive.ts`, `web/derive.test.ts`               | Page model | `REACHED`, news          | Edit         |
| `web/spec/tickets.tsx`                              | Kit page   | Reads of `ticket.status` | Edit         |
| `web/replay.ts`                                     | Dev feed   | Recorded frames          | Edit         |
| `factory/README.md`                                 | Operation  | Feed fields              | Edit         |

Build order: type, readers, replay, rendered check, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                           | Expected result / action                        |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                        | Record the dispatch revision; clean tree.       |
| `git diff --stat bbad3fc..HEAD -- factory/ web/`                  | Revalidate drift, including F012 and F014.      |
| `git diff -- factory/ web/ && git diff --cached -- factory/ web/` | Preserve unrelated changes.                     |
| `rg -n "stage" factory/dashboard.ts`                              | Present; F014 accepted first.                   |
| `GIT_CONFIG_GLOBAL=/dev/null bun test`                            | Passes; CI runners have no global Git identity. |

## Done when

- [ ] The feed has no `status` field and nothing reads one.
- [ ] The page shows the same thing for every stage, checked in screenshots.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
