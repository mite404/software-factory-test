# repair-escalation-ticket1

## Status

- Goal: resume reviewed repairs after escalation without replacing the worker or weakening gates.
- Initial priority: P0
- Effort: Medium
- Risk: elevated; changes durable ownership and candidate acceptance orchestration.
- Depends on: native persistence and conditional post-graft review.
- Planned at: `2558ccc9d7a9a6d2a7c7d034c597d7e9faeae594`, `2026-11-13`.
- Mode: local-only. Native adoption of a locally verified coordinator control bootstrap.

## Why this matters

Two failed attempts must trigger diagnosis, not permanently prevent a difficult ticket from passing.

## Current state

The checked-in native rejection path discards retry metadata on its second rejection. A local
coordinator bootstrap passed 98 tests and restored F14's original worker at attempt three using
durable review events. F14 then passed native gates and cold review. The bootstrap source itself
still needs adoption through this native worker ticket and independent review.

## Approach

Preserve a repair checkpoint on escalation. Add owner-only `resume` with an explicit decision.
Recover pre-upgrade review blocks only from matching durable events and the candidate report.

## Scope

Native rejection, persistence validation, registered control input, behavioral tests and
instructions. No replacement workers, direct runtime-state edits, publication, deployment or
remote tickets.

## Steps

1. Prove escalation and same-worker continuation beyond attempt two using real Git and SQLite.
2. Add validated checkpoints and serialized owner-only resumption without changing acceptance.
3. Preserve F14 preparation and retry-setup behavior while adapting the supplied bootstrap patch.
4. Run full gates and submit the exact candidate for native staging and fresh cold review.

## Test plan

Exercise repeated review rejection, reload, paused resumption, unknown activity, unauthorized
callers, and pre-upgrade recovery. Require an exact-revision pass before integration. Run all gates.

## Why this approach?

The failure is lost continuation state, not a weak reviewer. Keeping ownership and monotonically
increasing attempts makes escalation recoverable while preserving the independent acceptance gate.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/persistence.ts` | Storage boundary | Validated checkpoint and retained events | Edit |
| `factory/native.ts` | Lifecycle owner | Rejection, escalation, resume and gates | Edit |
| `factory/plugin.ts` | Control boundary | Registered Foreman command | Edit |
| `factory/native.test.ts` | API proof | Real Git and SQLite dispatch | Edit |
| `factory/review.test.ts` | Acceptance proof | Cold review and same-worker repair | Edit |
| `factory/foreman.md` | Agent contract | Escalation procedure | Edit |
| `factory/README.md` | Operator contract | Resume prerequisites | Edit |

Build order: persistence, lifecycle, control boundary, documentation. Existing dashboard states
remain.

## Initial state / preflight

F14 is accepted at the planning revision. The coordinator supplies the bootstrap patch path in the
dispatch prompt. Apply it only in the assigned worktree, adapting conflicts rather than overwriting
newer preparation code. Do not edit the parent checkout, queue, configuration or runtime state.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Compare with planning SHA; revalidate committed drift. |
| `git status --short` | Preserve existing PRD, backlog and ticket edits. |
| `git diff --stat 2558ccc9d7a9a6d2a7c7d034c597d7e9faeae594..HEAD -- factory/` | Inspect drift. |
| `git diff -- factory/; git diff --cached -- factory/` | Account for local and staged edits. |
| `bun run test` | All tests pass; full log retained under `.amp/in/orb-backup/`. |
| `bun run lint:ci && bun run typecheck && bun run format:check` | All gates pass. |
| `bun run fallow:ci && bash factory/checks.sh guard && git diff --check` | No gate failures. |

Bootstrap regressions failed before repair and full local gates passed. This does not substitute
for verification of the adopted code against the newer preparation implementation.

## Done when

- [ ] Two rejections preserve evidence and escalate without accepting or replacing the worker.
- [ ] The owning Foreman records a decision and resumes increasing attempts across reloads.
- [ ] Paused, uncertain, stale-base and unauthorized operations cannot dispatch or accept code.
- [ ] Repaired candidates pass normal gates and fresh conditional review before integration.
- [ ] Adopted source passes full gates and native cold review before coordinator integration.

## Notes

Intentional reconnection tests begin with `[TEST] Intentional reconnection test.` and require a
`[TEST]` thread-title prefix and opening status. Real outage recovery is not a test. The supplied
patch includes this Foreman instruction; preserve the distinction without adding a second queue.
