# ticket-step-labels-ticket1

## Status

- Goal: expose authored ticket steps and the current target branch to the pipeline frontend.
- Initial priority: P0
- Effort: Medium
- Risk: private queue data crosses a curated public HTTP boundary.
- Depends on: accepted launcher and durable dashboard projection.
- Planned at: `213d14c56b8744663e2e234354af5203994550b4`, `2026-11-13`.
- Mode: local-only.

## Why this matters

Pipeline rows need short task-specific chips instead of full implementation sentences.

## Current state

`tasks` in `factory/native.ts` drops unknown queue fields. `Task` in persistence has no steps.
The plugin writes observation snapshots; the HTTP projection uses durable ticket identities only.
The frontend owner independently added a top-level target branch field in its separate checkout.

## Approach

Add optional queue `steps: string[]`, retaining ordered nonblank labels. Pass them through durable
ticket records, observation snapshots, and per-task HTTP projection. Missing labels become an empty
list in the feed. Preserve historical tickets and snapshots without this field. Validate external
labels instead of casting them. Keep durable labels visible without fresh observations and prevent
heartbeat data from overriding durable labels. Expose only labels, never private brief/report data.

Add top-level HTTP `target: string` from the root checkout's `git branch --show-current`, using
`detached HEAD` for an empty branch name. Include it in normal and missing-storage responses and
keep it current when the branch changes after server startup. No current-step telemetry is required;
the factory does not know which implementation step the worker is executing.

## Scope

- In: factory TypeScript, behavioral tests, README, and the creating-factory-tickets skill/example.
- Out: frontend HTML, unrelated skills, runtime state, coordinator queue/config, and remote writes.
- Allowed edits: `factory/` except `factory/dashboard.html`, and
  `.agents/skills/creating-factory-tickets/` only.

## Steps

1. **Preserve queue step labels.** Validate optional labels and retain them in durable ticket data.
2. **Expose labels and target.** Carry labels through snapshots and HTTP without exposing briefs.
3. **Teach concise ticket steps.** Give skill and example steps three-to-five-word bold labels
   beside their full sentence, and document copying those labels into ordered queue `steps`.
4. **Verify legacy and privacy.** Exercise real HTTP/SQLite and retain all full acceptance gates.

## Test plan

Start with failing public behavior. Cover ordered distinct labels, legacy missing fields, malformed
labels, absent/stale observations, persisted retained tickets, and private-field canaries. Verify
normal and missing-storage target responses, changed branch, and detached HEAD with real Git.
Extend existing tests; do not invent activity or add a Markdown parser. Inspect callers before
changing the durable-record shape. Run full gates and guard on the exact clean committed candidate.

## Why this approach?

Authored queue labels are stable data; parsing prose or inferring progress invents a second source
of truth. Validated durable projection keeps ticket chips available when worker observations fail.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/persistence.ts` | Durable boundary | Task shape and read-only records | Edit |
| `factory/native.ts` | Queue boundary | Ticket parser | Edit |
| `factory/plugin.ts` | Snapshot producer | Per-task observations | Edit |
| `factory/dashboard.ts` | HTTP boundary | Curated task projection | Edit |
| `factory/*.test.ts` | Behavioral proof | Real Git, SQLite, HTTP and adapter tests | Edit |
| `factory/README.md` | Operator contract | Queue and API fields | Edit |
| `.agents/skills/creating-factory-tickets/SKILL.md` | Authoring contract | Labeled steps and queue | Edit |
| `.agents/skills/creating-factory-tickets/EXAMPLE.md` | Authoring example | Steps and queue example | Edit |

Build order: queue and durable data, snapshot and HTTP, skill/example, full verification.

## Initial state / preflight

Parent planning revision is above; dogfood prerequisite is
`2dce63c6aa4b43ff268cfc093dd97e2a4f649724`. Intake commits are expected drift, not missing features.
Checks below have not been executed for this new scope.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record actual dispatch revision and explain drift. |
| `git status --short` | Begin clean; preserve unrelated changes. |
| `git diff --stat 2dce63c6aa4b43ff268cfc093dd97e2a4f649724..HEAD -- factory/ .agents/skills/` | Inspect drift. |
| `git diff -- factory/ .agents/skills/` | No unexplained unstaged changes. |
| `git diff --cached -- factory/ .agents/skills/` | No unexplained staged changes. |
| `bun --version` | Confirm declared runtime support. |
| `bun test && bun run lint:ci && bun run typecheck` | Save actual baseline output. |
| `bun run format:check && bun run fallow:ci` | Retain required checks. |
| `bash factory/checks.sh guard && git diff --check` | Guard and whitespace pass. |

## Done when

- [x] Queue accepts optional ordered labels and rejects malformed labels.
- [x] Snapshot and HTTP task `steps` are validated and legacy-compatible.
- [x] Durable labels survive missing/stale observations without exposing private queue fields.
- [x] HTTP `target` is correct for normal, missing-storage, changed-branch and detached cases.
- [x] Skill and example teach short labels beside full sentences and matching queue `steps`.
- [x] Exact clean candidate passes all gates, guard and native cold review.

## Notes

Native attempt two accepted revision `8ca246115ee15be3d0d0cb12f6ef7430e78f91f9` after same-worker
repair and fresh cold review with no findings. Parent files match accepted source exactly.
Parent verification passed 126 tests, all configured gates and guard. A real HTTP request against
the dogfood repository returned the accepted task's four ordered labels and `feat/judge-integration`
as target. Skill example labels match its queue JSON exactly and contain three to five words each.
No current-step progress is inferred. Nothing has been pushed.
