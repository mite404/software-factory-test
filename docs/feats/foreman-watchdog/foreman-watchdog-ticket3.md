# foreman-watchdog-ticket3

## Status

- Goal: recover a sleeping Foreman and deliver persisted alerts through Amp's control plane.
- Initial priority: P0. Effort: Medium.
- Risk: elevated; schedule ownership and ambiguous external effects span process boundaries.
- Depends on: foreman-watchdog-ticket2.
- Planned at: `2c00930f414d29708ad022384d5c1912ce6b067a`, 2026-11-14. Local only.
- Authorized external effects: factory-owned Amp watchdog schedule and requested user alerts only.

## Why this matters

A local timer cannot run in a paused orb. A notifier inside the same failed Foreman cannot promise
to report that Foreman's total failure. Both the recovery path and its boundary need real proof.

## Current state

`get_schedule` returned null for this Foreman during scoping. Amp's automation docs say an existing
thread schedule wakes the agent and resumes its orb when tools are needed. `PluginTools.call`
supports built-ins under normal permissions, but schedule and notification bridges have not been
tested through the installed factory plugin. `notify_user` sends push and optional email, with a
platform limit of ten notifications per thread per hour.

## Approach

Prove the installed tool bridge first. Use one factory-owned, existing-thread watchdog schedule,
normally every 30 minutes, targeting the actual owning Foreman. Register from authorized start;
recover missing registration on reload/reconciliation. Treat registration and SQLite as separate
effects: inspect actual schedule state after ambiguity before retrying. Match ownership by a stable
factory/root fingerprint, preserve unrelated schedules, and clear only this watchdog on intentional
pause or completion. Repeated start accepts its own existing registration.

One thread has one schedule. Reject a second active factory root visibly unless the existing owner
watchdog explicitly aggregates it; do not build a second scheduler or silently replace a schedule.
Installation failure must not claim monitored execution. Preserve enough state for safe recovery.

Deliver persisted nudges/alerts only from an authorized connected owner context, not from status,
HTTP or a worker/reviewer call. A scheduled turn reads the saved prompt, reconciles durable state,
diagnoses current incidents and uses the supported exact-incident action. It does not blindly
resume, grant permission, replace workers, accept code or retry uncertain remote effects.

Verify platform failure-notification behavior. If an unstartable Foreman cannot independently notify
its owner, expose that as an explicit unsupported coverage boundary, not a green guarantee. Do not
provision another service silently. A separately hosted failure monitor requires a concrete
provider/permission decision if Amp cannot provide the approved outside-orb alert coverage.

## Scope

- In: native Amp schedule lifecycle, notification delivery/recovery and installed-host proof.
- Out: keepAlive leases, global schedules, application deployment, remote pushes and frontend.
- Only the coordinator installs the real watchdog after acceptance. Workers use isolated TEST
  fixtures and must not pause the real dogfood orb or alter its existing schedule/runtime records.

## Steps

1. **Verify native control bridges**. Exercise installed schedule reads and notification
   capabilities.
2. **Own watchdog schedule lifecycle**. Reconcile registration, conflict, pause and completion
   safely.
3. **Prove sleeping Foreman recovery**. Exercise a labeled paused-orb fixture and alert boundaries.

## Test plan

Test unrelated-schedule preservation, repeated start, ambiguous create/clear, unavailable tool
context, caller denial before side effects, notification rate/deduplication and reload recovery. Use
a disposable labeled TEST fixture with a cheap Luna Foreman receiver; capture before/after durable
state, the real schedule firing, paused-orb restoration, plugin load and safe action. The experiment
must actually sleep the fixture orb, not simulate pause inside an active process. Keep all delivery
logs private; user-facing push/email carries only curated incident facts. Report live proof and
fake-boundary tests separately. Never claim platform-outage alerting from a test where the same
Foreman successfully ran the alert tool.

## Why this approach?

Native schedules already outlive orb sleep. Explicit ownership and recovery prevent one factory from
stealing another automation, while honest failure coverage prevents another silent stall.

## Files You'll Touch

| Path                                                    | Role              | Contains                             | Edit or Read   |
| ------------------------------------------------------- | ----------------- | ------------------------------------ | -------------- |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | External boundary | Connected schedule/alert tools       | Edit           |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle         | Authorized lifecycle and recovery    | Edit           |
| `factory/persistence.ts`, `factory/persistence.test.ts` | State             | Ambiguous effects and ownership      | Edit if needed |
| `factory/foreman.md`, `factory/README.md`               | Contract          | Saved prompt, limits and operations  | Edit           |
| `node_modules/@ampcode/plugin/index.d.ts`               | API               | Connected tool and message semantics | Read           |

Reuse accepted incident/alert records. Agent-facing text requires writing-prompts. Load
building-schedules before schedule tools. Use controlled adapters before live fixture effects.

## Initial state / preflight

Run shared preflight in `docs/v1-execution.md`; runtime bridge and sleep checks remain pending.

| Command                                                 | Expected result / action                            |
| ------------------------------------------------------- | --------------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Confirm accepted incident and timing prerequisites. |
| `git diff --stat 2c00930..HEAD -- factory/`             | Inspect current adapters and permission checks.     |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                         |

## Done when

- [ ] Schedule lifecycle is authorized, idempotent and isolated from unrelated automations.
- [ ] Actual scheduled wake restores a paused TEST orb and diagnoses the exact persisted incident.
- [ ] Durable alerts deliver safely, with ambiguity, caller and platform failure limits explicit.
- [ ] Full gates, guard and fresh cold review pass; unavailable independent coverage stays pending.
