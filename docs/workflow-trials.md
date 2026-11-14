# Factory workflow trials

Historical trial evidence migrated from revision 4 of the
[Factory workflow trials artifact][trial-artifact].
Current requirements live in [prd.md](prd.md); architectural decisions live in [adr.md](adr.md).

The merge-retry and scheduling-policy simulations passed. The bug-judge simulation exposed three
rating disagreements; a revised evidence-extraction plus deterministic-rating trial matched all five
fixtures. These are scratch prototypes, not an installed factory plugin. Design Workbench, pstack,
action-checks, real schedules, and real Linear tickets remain unchanged. No user action is needed.

## Trial 1 passed: semantic merge rejection

- Model: GPT-6 Luna. Two builder threads and one retry in the consumer thread.
- Fixture engine: local commit `8133a0e`; worker base `c1f19ca` differs only in setup scripts.
- Scout and reviewer model calls were disabled. Changes were deliberately tiny.
- `factory/test.sh` passed with `ENGINE OK` before the real-model trial.
- Both builders passed separate gates. The rename landed first under controlled queue order.
- The consumer merged without a Git conflict but failed compile with TS2305, missing `MAX_SLUG`.
- The task returned to `ready`, owner `b2`, bounce count 1. Main and main-green still matched.
- The retry retained the consumer's session URL. Its engine prompt was 370 bytes, with two error
  lines and a full-log path rather than the original task body.
- The same Luna thread repaired the consumer. It submitted and landed on the second attempt.
- `factory/verify.sh b0002` returned `VERIFIED b0002`: the acceptance command failed on the
  landing's parent and passed with the full gate on a fresh clone.
- `verify-trial.sh` returned `TRIAL OK`, checking owner/session retention, exactly one bounce,
  failure-log separation, and matching main/main-green refs.
- No factory engine change was needed for this case. No test changes were pushed to GitHub.

[Rename worker][rename-worker]

[Consumer and retry worker][consumer-worker]

### This trial did not prove unattended dispatch

Native Amp threads ran in separate orbs. A FIFO adapter held each factory agent invocation while
this coordinator copied changed files into the engine's actual worktree. The engine performed its
normal claim, proof, integration, bounce, and after-check operations. The retry used the same native
thread and received the merged limit files and failure log. Initial worker prompts were concise
equivalents of the engine task prompts. The coordinator controlled landing order by touching the
consumer's submission timestamp.

This proves engine transitions and real-model repair, not unattended thread creation, PRD selection,
Linear lifecycle, automatic context routing, or restart reconciliation. Those remain unverified.
Exact model token usage is unavailable; no token savings are claimed.

## Trial 2: scheduled recovery with duplicate wake-ups

One GPT-6 Luna thread applied the proposed policy to eleven isolated fake factory states, then
processed an immediate duplicate wake-up against the changed durable state. The executor recorded
actions without suppressing unsafe choices, so duplicate protection was not silently supplied by
the fake backend.

All eleven first-pass cases and eleven duplicate-pass cases matched the preregistered expectations.
They covered running workers with spare capacity, human-blocked work alongside independent work,
actionable idle workers, pending messages, unverified completion claims, accepted completion
followed by dependent dispatch, empty queues, selected/default discovery modes, cooldown, pause,
and missing configuration. Duplicate wake-ups produced no actions.

The grader separately checked case coverage and event consistency. Its final combined result was
`32/32`, including five judge cases and five structural checks, not 32 independent scheduling
scenarios. Negative controls caught duplicate dispatch, closing an unverified ticket, and
downgrading a blocked core-workflow failure.

[Scheduling trial][scheduling-trial]

This was one batched simulation, not a statistical reliability claim. It did not create real worker
threads from a scheduler or test concurrent scheduling actors. Fake workers and fake acceptance
evidence were represented by state records.

## Trial 3: judge evidence separately from rating rules

The initial Luna judge correctly withheld the unverified cookie hypothesis and recognized the
existing accessibility ticket. However, three findings disagreed with the preregistered rubric:

| Finding | Initial judgment | Expected rule |
| --- | --- | --- |
| Cross-tenant invoice disclosure | P0, radius 2 | Shared/multiple-tenant reach is radius 3 |
| Missing keyboard focus | P3 accessibility | Accessibility degradation is not cosmetic, P2 |
| Save failure for all fixture accounts | P2, blocked | Broad core-workflow failure is P1 despite an older-client workaround |

These were simulation-policy errors, not findings against pstack or action-checks.

The revised trial used a fresh Luna thread to extract categorical evidence. `rate.py` assigned
priority, numeric impact/radius/confidence, and filing disposition by explicit rules. All five
fixture judgments then matched the preregistered expectations. The parent reran the code on the
extracted facts and obtained byte-identical judgments.

| Finding | Revised disposition | Priority | Fix scope |
| --- | --- | --- | --- |
| Cross-tenant disclosure | File | P0 | Local |
| Untested old-cookie hypothesis | Investigate | Unrated | Unknown |
| Existing keyboard-focus issue | Existing ticket | P2 | Local |
| Widespread save failure | File, blocked | P1 | Cross-cutting |
| Tooltip alignment only | File | P3 | Local |

[Initial judge][initial-judge]

[Revised judge][revised-judge]

The model still interprets evidence. Deterministic ratings do not prove that the evidence is true.
Production filing must require actual reproduction receipts and duplicate checks; the synthetic
evidence here was supplied by the fixture. No held-out findings were tested.

## Reuse probes exercised existing code without changing it

The existing personal Plugins repository contains `action-checks.ts`. The available pstack
orchestration implementation is the poteto-mode skill's `scripts/orch/store.ts` and `orch.ts`. The
latter is explicitly bookkeeping-only; it does not spawn or wake workers.

A local probe imported these existing implementations directly:

- Poteto's store preserved independent pending work and a parked human gate across reopening.
- A verification receipt for revision A did not authorize revision B.
- Eight competing claims produced exactly one durable dispatch intent, using the store's lock and
  unique-unit checks. This proves one intent, not exactly-once remote thread creation.
- The real action-checks hook ran a failing fixture command and returned a continuation. Repairing
  the command removed the continuation. Event plumbing used a simulated PluginAPI host; no
  model/provider API was involved.

The smoke harness initially passed Bun Buffer outputs where Amp supplies string outputs.
Correcting that test adapter made the hook probe pass. No plugin fix was needed.

Use these APIs instead of copying their implementations into the factory. The factory still needs
its own explicit ticket transitions, dispatch reconciliation, and acceptance policy. Never infer
accepted completion from `agent.end`: action-checks may request another turn, and Amp does not
define ordering between different plugins' event handlers. Bind acceptance to the actual revision
and verification evidence, not a worker's final text or hook ordering.

Local probe sources remain under `.amp/in/scratchpad/scheduling-policy/`. They are not installed
plugins or tracked product code. The clone of the user's Plugins repository was read-only.

## Supported API direction, not an implemented replacement

The [Amp plugin API](https://ampcode.com/docs/plugin-api) documents `Agent.createThread`, thread
`state` observables, and `waitForResponse`. These provide a possible programmatic
dispatch/completion mechanism without reminder threads. They do not by themselves provide durable
ticket state, accepted-result verification, crash recovery, or code transfer between worker orbs.
Those boundaries must be tested before calling the replacement unattended.

## Trial 4: build one backend ticket through the native factory

2026-11-13. The parent orchestrator authored
[feature 01](features/feature-01/feature-01-impl.md), then copied its exact uncommitted source into
a committed disposable repository. The queue contained only that ticket, capacity was one, and
the worker model was `openai/gpt-6-luna`. No discovery worker, review panel, or nested agent ran.

[One native worker](https://ampcode.com/threads/T-01a1d2d5-0542-7306-8e75-d7dbd5233106)
implemented explicit installer refresh. The real CLI check failed before the change and passed
after it. Native Amp state observation triggered verification and fast-forward integration without
another dispatch prompt. The parent inspected the accepted revision, applied its three-file patch,
and independently verified the result here. No source was pushed.

The parent's `bun test` run reported 43 pass, 0 fail, and 226 assertions across 14 files.
Strict installer TypeScript, formatting, and whitespace checks passed. A separate CLI probe in two
repos verified custom queue paths, changed permissions, application and runtime file preservation,
invalid configuration refusal, a real compilation failure, and missing-plugin recovery.

The worker initially compared complete generated bundles. Temporary entry paths made that check
unstable, so it checked replacement instead. Its final missing-store negative control tested
validation failure, not compilation failure. The parent added the actual compilation-failure
probe before declaring the story verified. Future tickets must name the failure boundary their
checks actually reach rather than equating all nonzero exits.

This proves one local native dispatch, implementation, revision-bound check, integration, and
parent review. It does not prove separate worker-orb transfer, private backups, restart recovery,
or safe retirement. The factory was paused after acceptance, and the worker was left intact.
Evidence and the repeatable probe remain under `.amp/in/scratchpad/factory-self-build/`.

## Trial 5: explicit Sol effort and a disconnected-worker recovery failure

2026-11-13. [Feature 02](features/feature-02/feature-02-impl.md) used exactly
[one Sol implementation worker](https://ampcode.com/threads/T-01a1d2e7-167f-714d-9afc-3e9e116f9f71).
A disposable bootstrap set medium through native Amp configuration and inspected the resolved
agent definition before creation. The worker implemented the product's model/effort path.

The parent reviewed the six-file patch and reran the suite: 45 pass, 0 fail, 294 assertions.
Strict SDK TypeScript, targeted formatting, and whitespace checks passed. A separate native probe
called the real product adapter and Amp agent-definition API with medium, high, and omitted
effort. The definitions preserved those values. It substituted thread execution and observations,
spawned no workers, and therefore does not prove live worker lifecycle behavior.

An executor interruption occurred during the parent verification transition. After the worker
finished, reconciliation failed with `thread.state is only available for connected threads`.
The supported thread-status tool independently reported idle and a completed final turn. The
candidate revision and its report remain available, but the factory did not emit acceptance or
integrate it. This sequence does not establish why the native connection was lost.

The parent applied and verified the patch locally, then paused dispatch. The recorded run remains
running rather than being rewritten as accepted. No replacement child, remote write, or retirement
occurred. The next workflow repair must recover the same worker's candidate after disconnection
and still require revision-bound verification before integration. Live automatic acceptance did
not pass this trial, despite the feature's passing local checks.

Sources, bootstrap receipts, and full logs are under `.amp/in/scratchpad/factory-feature-02/`.

## Trial 6: recover the original disconnected candidate

2026-11-13. [Feature 03](features/feature-03/feature-03-impl.md) used one Sol 6.1/medium worker.
The initial patch passed local tests but failed live acceptance because synchronous verification
blocked the plugin heartbeat. A diagnostic wrapper confirmed matching server idle state before
the block. The same worker then lost executor connectivity before correcting that second failure.

With explicit permission, the parent resumed that worker through CLI in a supervised service.
The amendment made verification asynchronous and added an event-loop responsiveness regression.
Parent verification passed 53 tests, 1,072 assertions, strict SDK TypeScript, and whitespace checks.

Both refreshed native plugins completed their real verification commands and integrated their
original candidates. Each fixture retained exactly one creation, delivery, acceptance, and ledger
entry after repeated reconciliation. Both root revisions matched the reports; both queues were
paused afterward. No replacement worker, remote write, or worker retirement occurred.

The one-shot CLI continuation was mistakenly run as an auto-restarting service. After completion,
the service repeatedly resubmitted the same prompt. The operator noticed the repeated messages;
the parent confirmed the restart counter and stopped the service. No continuation process remained.
Use a finite shell task for one-shot CLI continuation, not a restarting server service. This trial
preserved one worker and one acceptance, but did not preserve one corrective prompt submission.

This proves explicit reconciliation after disconnect. It does not prove automatic executor
reattachment or context-free server status observation. Full logs and patches remain under
`.amp/in/scratchpad/factory-feature-03/` and the preserved Feature 02 fixture.

## Trial 7: atomic SQLite persistence and real legacy migration

2026-11-13. One Sol 6.1/medium worker implemented Feature 04. The factory accepted its first
candidate in the disposable repo. Parent review reran 74 tests, strict SDK TypeScript, and
whitespace checks. A forced database failure test rolled back both ownership and its claim event.

The parent refreshed the actual adapters for the previously accepted Feature 02 and Feature 03
fixtures. Both migrated their legacy JSON and JSONL records without changing the original bytes,
accepted revisions, or Git roots. Reopening and repeated reconciliation retained exactly one
acceptance each and kept both queues paused. No worker or model call was required for migration.

SQLite state and transition history are now authoritative. Candidate reports, poteto bookkeeping,
and dashboard projection retain their existing roles. This trial does not prove private backup
or restore in another orb. Full checks remain under `.amp/in/scratchpad/factory-feature-04/`.

## Trial 8 passed: unattended three-ticket Luna steel thread

2026-11-13. Three dependent, tiny data-file tickets ran with `openai/gpt-6-luna`, low effort,
and capacity one. The coordinator was started once and its plugin reloaded while A was running.
No manual reconciliation, worker continuation, code copying, or next-ticket prompt followed.

- A was verified and integrated, then B started automatically from A's accepted revision.
- B deliberately submitted a bad first candidate. The real gate rejected it with
  `B must contain 2`; the coordinator sent diagnostics to the original B worker.
- That worker committed its repair. The complete configured gate passed and C started
  automatically from B's accepted revision. C then passed and integrated.
- Read-only SQLite assertions found exactly three worker creations, three acceptances,
  one rejection, and four successful message deliveries. Both B deliveries named the same thread.
- The final integration checkout was clean and `sh verify.sh` returned `FIXTURE GATE PASSED`.
- Reloading again after completion and rerunning the assertions retained those exact counts.

Workers: [A][steel-a], [B and repair][steel-b], [C][steel-c]. No product-code fix was needed.
The earlier suspected recovery gap was not reached by this connected-worker plugin reload.
This proves local native dispatch, same-worker repair, dependent progression, and plugin reload,
not executor loss, orb replacement, missed-event recovery, remote CI/PR monitoring, or discovery.
Exact model-token usage was not measured. No remote writes or worker retirement occurred.

Fixture, read-only assertion script, and full logs remain under
`.amp/in/orb-backup/steel-thread-01/`. The empty queue was paused after verification.

[steel-a]: https://ampcode.com/threads/T-01a1d3c8-203d-7510-b203-b3e90c53ed23
[steel-b]: https://ampcode.com/threads/T-01a1d3c8-c3b1-764d-9b30-bfad8baeecd6
[steel-c]: https://ampcode.com/threads/T-01a1d3ca-6fce-74b6-b1f8-749cba0dcde4

## Trial 9 passed: real backlog cold review and same-worker repair

2026-11-13. Feature-07 implemented the SQLite-backed observation API through the installed
native factory. One Sol 6.1 medium worker owned implementation and repair. Each post-graft
candidate received a fresh Fable 5.2 high review, without the worker transcript or prior verdict.

- The initial clean baseline failed Fallow because the worker had no local dependencies. Manual
  locked installation restored the full gate. The original blocked report and failing HTTP
  regression patch were preserved; recovery retained the worker and attempt 1. Automatic worktree
  setup remains backlog F14, not an unattended success in this trial.
- Candidate 1 passed the full gate but review raised SQLite reader/writer contention. The factory
  withheld integration and automatically returned findings to the original worker as attempt 2.
- The worker reproduced `SQLITE_BUSY` and HTTP 503 before fixing the storage connection timeout.
  It also distinguished exhausted lock waits from invalid storage and verified later recovery.
- Candidate 2 passed all six gates with 97 tests. A fresh reviewer returned a revision-, base-,
  stage-, ticket-, and attempt-bound pass. Only then did the factory fast-forward integration.
- SQLite records show one worker creation, one rejection, two reviewer creations/deliveries, and
  one acceptance. Reloading during the first review preserved its thread and created no duplicate.
- The fixture integration checkout is clean at `7a8c1dfd07eb6c45f092eb2b5e15b40911ed57f0`.
  The accepted patch was copied to the parent checkout, where the combined full gate also passed.
  Parent integration is manual, not unattended transfer; nothing was pushed or deployed.

The pending-review dashboard was rendered and inspected: accepted work remained accepted, the
candidate showed working review, and no private paths appeared. Full logs, SQLite history,
revision-bound verdicts, staging worktrees, and the accepted patch remain under
`.amp/in/orb-backup/judge-dogfood/`. The exhausted fixture queue was paused after acceptance.
This proves the live local review/rejection/repair/acceptance loop, not cross-orb delivery,
unattended setup recovery, private backup/restore, or retirement. Token usage was not measured.

[Implementation and repair][observation-worker], [first review][observation-review-one],
[fresh repair review][observation-review-two].

[observation-worker]: https://ampcode.com/threads/T-01a1d41f-64ba-723b-a510-9fa9e3613966
[observation-review-one]: https://ampcode.com/threads/T-01a1d436-2aa9-7670-a305-683b483040eb
[observation-review-two]: https://ampcode.com/threads/T-01a1d444-bc60-756a-be19-4f5653043df3

## Trial 10: accepted candidate stranded in a replaced coordinator orb

2026-11-14. A new Foreman thread started in a fresh orb to integrate accepted v1-ticket2. Candidate
`901ae38` existed only in the previous orb's dogfood repository; origin answered `not our ref` and
no patch or bundle had been preserved. Every remaining unit was blocked on it.

- The previous Foreman thread exported a read-only Git bundle, patch, review receipt, gate log and
  report on request. Native thread file transfer delivered them; all seven SHA-256 values matched,
  the bundle verified, and the regenerated diff matched the transferred patch byte for byte.
- Parent main had moved 363 lines in `factory/` since the candidate's base, including the
  `message-foreman` action and preflight resume. A three-way apply conflicted in four files. The
  Foreman kept both behaviors; this merge was not cold-reviewed.
- The combined gate passed in the parent: 150 tests, strict lint, type check, formatting, Fallow
  and the guard. `/api/definition` answered through a real dashboard process.

This recovery depended on the old orb still existing and its thread answering. It is manual
evidence for v1-ticket9 and v1-ticket17, not proof of either: accepted work must leave the
coordinator orb at acceptance, not when a successor asks for it. Handoff files remain under
`.amp/in/orb-backup/v1-ticket2-handoff/`. Nothing was pushed or retired.

[trial-artifact]:
  https://ampcode.com/artifacts/factory-workflow-trials-36c5101e-8f2e-4e6c-ab3f-0a4425873f7e
[source-workflow]: https://ampcode.com/threads/T-01a1ce51-ec2c-73cf-9b63-a2eb9f40442b
[rename-worker]: https://ampcode.com/threads/T-01a1d208-909b-7726-8b37-40e40e5ba5c2
[consumer-worker]: https://ampcode.com/threads/T-01a1d208-9998-7364-9812-19028e671c9c
[scheduling-trial]: https://ampcode.com/threads/T-01a1d222-0e10-7674-a170-6b3e0200e60e
[initial-judge]: https://ampcode.com/threads/T-01a1d222-1528-7521-b790-d8c241707bcb
[revised-judge]: https://ampcode.com/threads/T-01a1d225-35fe-73df-98d8-649e451a2ff3
