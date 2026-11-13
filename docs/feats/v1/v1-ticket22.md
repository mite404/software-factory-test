# v1-ticket22

## Status

- Goal: prove the complete v1 workflow across independent coordinator and worker environments.
- Initial priority: P0. Effort: Medium. Risk: elevated; fixture proof cannot close live criteria.
- Depends on: every other unit in `docs/v1-execution.md`.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: cross-feature acceptance. Local only; live privileged proof remains permission-limited.

## Why this matters

Trials 8 and 9 prove a local steel thread, not full remote recovery, preservation, and retirement.

## Current state

Accepted local native work includes rejection, same-worker repair, cold review, preparation,
escalation, and integration. The completion program records outstanding R1-R16 and AC1-AC40 proof.

## Approach

Use a tiny application and Luna workflow workers. Install, discover, dispatch, reject/repair,
gate/review, integrate, retain a lesson, checkpoint, restore, and evaluate retirement in independent
environments. Keep payloads and fixture code minimal; measure workflow correctness, not code
quality.

## Scope

Include reproducible trial inputs and evidence mapping. Exclude inventing product requirements,
large model comparisons, production writes, unauthorized remote pushes, and real worker deletion. If
a required live action needs permission, finish independent checks and report that exact gap.

## Steps

1. **Prepare minimal independent environments**. Record exact source, definition, and authorized
   actions.
2. **Exercise rejection through restoration**. Preserve ownership and revision evidence across
   restart.
3. **Audit every acceptance criterion**. Separate native proof, fixtures, blocked checks, and
   exclusions.

## Test plan

Include failed-access restore, missing worktree, duplicate event, unknown activity, stale main,
unconfirmed snapshot, and disabled permission controls. Observe one new transition through the live
frontend. Intentional disconnection fixtures say TEST in prompt/title. Save full evidence privately.

## Why this approach?

A small real workflow exposes lifecycle failures without spending tokens on an elaborate sample app.

## Files You'll Touch

| Path                             | Role                 | Contains                         | Edit or Read            |
| -------------------------------- | -------------------- | -------------------------------- | ----------------------- |
| `docs/workflow-trials.md`        | Evidence index       | Observed outcomes and limits     | Edit                    |
| `docs/prd.md`, `docs/backlog.md` | Acceptance           | Requirement and delivery status  | Edit by coordinator     |
| `factory/`                       | Existing runtime     | Accepted product under test      | Read                    |
| `.amp/in/orb-backup/`            | Private trial record | Minimal inputs and full evidence | Create scoped artifacts |

Report implementation defects as bounded tickets; do not patch the product outside native
acceptance.

## Initial state / preflight

Execute common preflight in `docs/v1-execution.md`. Native trial checks have not run for this
ticket.

| Command              | Expected result / action                                           |
| -------------------- | ------------------------------------------------------------------ |
| `git rev-parse HEAD` | Record combined v1 source and all accepted prerequisite revisions. |
| `git status --short` | Preserve known work and isolate trial changes.                     |

## Done when

- [ ] Every R1-R16 and AC1-AC40 item has linked evidence or a concrete unresolved blocker.
- [ ] A true cross-orb steel thread is demonstrated without duplicate actions or lost ownership.
- [ ] No permission-limited or fixture-only criterion is called verified v1 completion.
