# foreman-watchdog-ticket1

## Status

- Goal: wake the owning Foreman when execution needs diagnosis without waiting for the user.
- Initial priority: P0. Effort: Medium.
- Risk: elevated; duplicate or stale notices must not resume the wrong repair.
- Depends on: v1-ticket2 and accepted canonical backup adoption.
- Planned at: `2c00930f414d29708ad022384d5c1912ce6b067a`, 2026-11-14.
- Local only. Approved watchdog design; implementation and live proof remain pending.

## Why this matters

The dogfood run needed an active coordinator turn to resume attempts three and five. When the
Foreman is idle, the current checkpoint can silently block the entire serialized queue.

## Current state

`createFactory` in `factory/native.ts` persists escalation but sends no owner notice. `host.send` in
`factory/plugin.ts` appends an Amp user message. The heartbeat only publishes observations.
`resumeRepair` checks ownership and safety but does not bind a request to a specific checkpoint.

## Approach

Persist a notice with the stop transition, owned by the current Foreman and a stable incident
identity including ticket, attempt and base. Drain it through serialized reconciliation and replay
after reload. Use existing thread messaging, not another worker or queue. Delivery is at-least-once;
bind repair decisions to the exact incident so an ambiguous send cannot duplicate effects.

Cover escalation, preparation failure, uncertain delivery, changed integration/review identity, and
observed worker errors. Classify stops by the recovery action they actually support. Do not infer
every stop from `kind: blocked` or prescribe `resume` for setup or uncertain delivery.

## Scope

- In: durable incidents/notices, owner delivery, checkpoint-bound recovery, registered adapter.
- Out: timed stalls, external schedules, user alert policy and frontend changes; tickets 2 and 3
  below own those. No new permission, worker replacement, forced acceptance or automatic base reset.
- Preserve explicit pause. Status and HTTP reads must neither deliver messages nor mutate state.

## Steps

1. **Persist actionable stop incidents**. Record curated reason kinds and notice identity
   atomically.
2. **Wake the owning Foreman**. Reconcile queued delivery and reload recovery using existing
   messaging.
3. **Reject stale repair decisions**. Bind recovery to the current incident and original worker.

## Test plan

Reproduce an idle owner receiving no notice after two real fixture rejections before the fix.
Exercise SQLite and the registered adapter, including crash before send, append succeeding before
acknowledgment, failed send, reload, stale notice at a later checkpoint and owner replacement.
Assert one normal successful delivery, allow duplicate messages after ambiguity, and prove no
duplicate repair effect. Preserve private canaries and every acceptance gate. Unknown activity is
not idle. Permission blockers never grant permission. Use cheap labeled TEST receivers for live
message wake-up, not an expensive implementation worker as a polling probe.

## Why this approach?

A saved event is not a Foreman turn. A durable incident preserves the handoff across process loss
while exact checkpoint binding prevents an old decision from acting on a newer failure.

## Files You'll Touch

| Path                                                    | Role      | Contains                                        | Edit or Read |
| ------------------------------------------------------- | --------- | ----------------------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | State     | Stop and notice validation                      | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle | Stop transitions and recovery guards            | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Adapter   | Owner messaging and caller context              | Edit         |
| `factory/foreman.md`, `factory/README.md`               | Contract  | Trusted diagnosis procedure and delivery limits | Edit         |
| `node_modules/@ampcode/plugin/index.d.ts`               | API       | Installed messaging contract                    | Read         |

Build durable identity and public behavior tests before adapter delivery. Reuse current modules.
Agent-facing text edits require writing-prompts. No coordinator queue or runtime record edits.

## Initial state / preflight

Run the full shared preflight in `docs/v1-execution.md` in the exact prepared worktree. These checks
have not run for this ticket; inspect prerequisite drift rather than overwriting accepted source.

| Command                                                 | Expected result / action                       |
| ------------------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record accepted prerequisites and clean base.  |
| `git diff --stat 2c00930..HEAD -- factory/`             | Revalidate current configuration and recovery. |
| `git diff -- factory/ && git diff --cached -- factory/` | Explain any existing changes.                  |

## Done when

- [ ] Each actionable stop durably requests the owning Foreman's diagnosis without user prompting.
- [ ] Ambiguous delivery and reload cannot lose an incident or resume a different checkpoint.
- [ ] Same worker, increasing attempts, serialized queue, explicit pause and full gates remain
      intact.
- [ ] Full gates, guard and fresh cold review pass; live wake evidence is labeled TEST.
