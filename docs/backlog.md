# Factory implementation backlog

Updated 2026-11-14. These are local user stories, not filed Linear tickets. No story authorizes
remote provisioning, pushes, application delivery, or worker deletion. Status describes observed
implementation, not acceptance of the design. See [PRD](prd.md) and [decisions](adr.md).

This backlog lists remaining work only. Completed installation basics, worker effort, SQLite
ownership, native cold review, worktree preparation (F14), repair escalation, launcher recovery,
title privacy, the backup command, and the first live dashboard are not new implementation tasks.
Their contracts and evidence remain in [factory/README.md](../factory/README.md), the linked ticket
records, and [workflow trials](workflow-trials.md). The integrated source and dashboard shipped in
[PR #3](https://github.com/mite404/software-factory-test/pull/3), with 140 local tests passing and
successful PR and post-merge CI.

The [remaining v1 execution inventory](v1-execution.md) retains 29 implementation/acceptance units
from the original 32. Public-title privacy, canonical backup adoption, and definition v1-ticket2 are
accepted natively. The definition is integrated into parent source with a passing combined gate, so
its dependents can be admitted in order. Historical feature tickets retain their original scope;
they are not the active queue. No extra execution or remote permission is granted by the inventory.

Core-first order after accepted backup adoption: definition v1-ticket2, three [Foreman watchdog
tickets](feats/foreman-watchdog/foreman-watchdog-ticket1.md), then [safe planned
intake](feats/planned-intake/planned-intake-ticket1.md). Evidence, gates, recovery and native
execution follow; service/frontend acceptance comes afterward. The owner approved this priority and
the watchdog's owned Amp schedule/user alerts, not unrelated external infrastructure. Full ordering
and admission rules live in the inventory, not in these older feature narratives.

## F01 - Install the factory as a repository service

As an operator, I can install and check the factory in an existing repo without changing my app or
starting workers, so I can adopt it project by project.

Priority: P0. Dependencies: integrated definition. Remaining unit: v1-ticket3. Repeat-safe setup,
check-only mode, adapter refresh, and same-origin dashboard hosting are implemented.

- Package coordinator and dashboard startup as repeat-safe repository services, not a one-off orb
  service invocation. Preserve the existing setup and permission guarantees.
- Prove the packaged services in two disposable repositories without source edits or provisioning.

## F02 - Persist coordinator state in SQLite

As an operator, I can restart the factory without losing its queue, ownership, or history, so
recovery does not depend on a model remembering the previous conversation.

Priority: P0. Dependencies: integrated definition. Core SQLite ownership, atomic events, legacy
migration, and ambiguous-operation recovery are implemented. Remaining unit: v1-ticket4.

- Preserve private, revision-bound evidence outside disposable worker storage, with protected
  references and schema migration. Existing coordinator tables do not preserve external artifacts.
- Retain structured lessons through F04. Preserve existing atomic transitions, unique claims,
  corruption refusal, and private-storage boundaries when extending the schema.

## F03 - Connect the coordinator to Amp

As an operator, I can bind the factory to one orchestrator thread and observe its workers, so
execution and the dashboard agree about which agents own the work.

Priority: P0. Dependencies: F01, F02. Local dispatch, model and effort, native observations,
observer reattachment, asynchronous gates, cold review, same-worker repairs, and Foreman escalation
are implemented. Observation reattachment is not executor recovery.

- Implement supported executor reconnection and prove exact cross-orb code/evidence transfer in
  v1-ticket10 and v1-ticket9. A disconnected worker must not be replaced because tools are absent.
- Add durable Foreman wake-up, stall diagnosis, nudges, and permitted alerts through the three
  watchdog tickets. An observer subscription alone does not supervise the Foreman.

## F04 - Retain phase lessons

As a later worker, I receive relevant findings and self-corrections from earlier phases, so I do not
repeat an already-understood failure or wrong turn.

Priority: P1. Dependencies: F02, F03. Status: planned; dependency insight prototype exists.

- At phase completion, record findings, bugs, failed approaches, corrections, and open questions.
- Each lesson carries project, phase, source thread, revision, affected scope, and evidence links.
- Repeated completion events do not duplicate lessons. Contradictions mark prior lessons superseded.
- Retrieve bounded, relevant lessons for affected work; unrelated workers do not receive them.
- A summary alone cannot mark work verified. Exclude credentials and full transcripts.

## F05 - Back up private state with one command

As an operator, I can run `factory backup` to save a project snapshot in a private GitHub repo, so
my application can remain public without publishing project memory.

Priority: P0. Dependencies: F02, F04. CLI and native-tool backup are accepted and merged.
Private destination checks, isolated project keys, consistent SQLite snapshots, separate permission,
serialized/no-op publication, receipts, and uncertain-push reconciliation are implemented.

- Extend snapshots to preserve required private evidence and lessons, including authorized phase
  checkpoints and exact preservation coverage. Remaining unit: v1-ticket6.
- Keep live private-remote acceptance explicitly pending until separately authorized. Disposable
  local Git remotes prove command behavior, not production publication or replacement-orb recovery.

## F06 - Restore safely in a replacement orchestrator orb

As an operator, I can start a new orchestrator orb and recover the project's latest backup, so
replacing the VM does not erase memory or duplicate running work.

Priority: P0. Dependencies: F02, F03, F05. Status: planned.

- Authenticate and restore the latest confirmed snapshot before dispatch. Validate project identity,
  database integrity, and schema compatibility.
- Missing expected state or failed access blocks startup. Only explicit initialization creates a new
  project; a normal restart must not overwrite newer local state with an older snapshot.
- Enforce one active orchestrator per project, including replacement ownership recovery. A rejected
  Git push is insufficient protection against concurrent dispatch.
- Reconcile saved worker IDs, revisions, messages, and integration outcomes before acting.
- Missing worktrees or unpreserved worker changes produce a blocker, not replacement workers.
- Demonstrate restoration in a second disposable orb, including a failed-access negative control.

## F07 - Serve a minimal observation API

As the dashboard, I can read a small project snapshot through the coordinator, so refreshing the
page needs neither model calls nor direct worker or filesystem access.

Priority: P0. Dependencies: F02, F03. The SQLite-backed read-only API, curated review references,
safe ticket-ID titles, freshness handling, and same-origin built frontend are accepted and merged.

- Add explicit lifecycle stages, gate outcomes, review/skip decisions, durable attempt/checkpoint
  identity, and bounded missed-poll replay through v1-ticket23.
- Project accepted planned-intake and watchdog facts without read side effects. Expose private
  evidence only through the protected references from v1-ticket4, never raw reports or secrets.

## F08 - Show the abstract factory workbench

As an operator, I can see named work and its status in a minimal animated pipeline, so I can
understand activity without reading every thread.

Priority: P1. Dependencies: F07. The live pipeline, builder/accepted-work links, labeled replay,
attempt label, status colors, freshness handling, and reduced-motion support are merged. Pending
review keeps its doors closed with looping mist and releases a packet once on an observed outcome.

- Show inspectable evidence and explicit lifecycle facts from v1-ticket23 through v1-ticket13.
  Preserve unknown and missing proof rather than inventing progress or success.
- Add a manual motion toggle and complete keyboard/evidence interaction and narrow-layout checks.
  Capture actual newly observed transitions, separately from labeled fixture animation checks.

## F09 - Trigger backups from the dashboard

As an operator, I can click **Back up now** and see whether my state reached the private repo, so I
do not need the terminal for each checkpoint.

Priority: P1. Dependencies: F05, F07, F08. Status: disabled frontend placeholder; operation pending.

- The button, CLI, and authorized phase checkpoints use the same backend operation.
- Use a protected POST endpoint with authorization and cross-origin request protection.
- A browser request cannot supply shell commands, credentials, or an alternate remote destination.
- Duplicate clicks do not overlap pushes. Show pending, confirmed, and failed outcomes and the last
  confirmed remote commit. Unconfigured backup is visibly disabled.

## F10 - Steer one orchestrator through chat

As an operator, I can send steering messages and read the orchestrator's replies in the dashboard,
so I can direct the factory without switching to the Amp transcript for ordinary conversation.

Priority: P1. Dependencies: F02, F03, F07, F08. Status: planned; no chat endpoint implemented.

- V1 sends every accepted message to the single configured orchestrator thread. The browser cannot
  select another thread or send directly to workers.
- Authenticate and authorize a bounded message through a protected POST endpoint. Keep Amp
  credentials server-side. The backend uses the supported native thread message API.
- Give each submission a durable client request ID and delivery state. A lost response cannot cause
  a blind duplicate append. Delivery uncertainty remains visible until reconciled.
- Preserve order during an active turn according to tested Amp message semantics. Show accepted,
  queued, delivered, failed, or uncertain status without claiming the agent acted on a message.
- Read replies and thread activity through the backend, correlate replies where possible, and retain
  context after refresh. A send acknowledgment is not the orchestrator's reply.
- Steering text does not silently grant publish, backup, or production permissions. Tool approvals
  remain explicit. V1 is not a generic remote shell or complete replacement for Amp's approval UI.

## F11 - Retire disposable workers without losing work

As an operator, I can release completed worker-orb resources while keeping ticket threads
unarchived, so implementation history stays visible after results have been safely preserved.

Priority: P0. Dependencies: F03, F04, F05, F06. Status: planned.

- Require revision-bound verification and integration before retirement. Rejection stays with the
  original worker; idle or final prose alone cannot trigger cleanup.
- Preserve accepted code and required evidence outside the worker orb, and confirm backup of the
  accepted outcome and lessons. Worker-local file links do not satisfy preservation.
- Failed backup or missing delivery permission blocks retirement without granting new permissions.
- Record acceptance and retirement separately. Repeated archive, shutdown, and cleanup requests are
  idempotent; missing evidence must leave recoverable work intact. Resource retirement does not
  archive the ticket's implementation thread. Finished review agents may be archived.

## F12 - Define each project's factory as code

As a project owner, I can review and customize my factory through versioned repository files, so
bespoke workflow details do not require a fork of the shared engine.

Priority: P0. Dependencies: F01, F03. Definition v1-ticket2 passed gates and fresh cold review at
attempt four and is integrated into parent source. YAML/schema loading, explicit migration, safe
checks, durable reload, and pinned worker briefs are implemented. See R15 and AC26-AC29 in
[prd.md](prd.md).

- Extend the contract only when service, discovery, verification-tool, hook, and dashboard
  capabilities exist. Unimplemented capabilities must remain explicit refusals.
- Discover existing `action-checks`, `ci-watch`, and `verify-<project-name>` capabilities. Reuse
  pstack-created app harnesses and applicable formal-verification checks, with required/advisory
  roles and explicit coverage. Do not create replacement tools or duplicate CI watchers by default.
- Bound hook actions by native event identity, permissions, timeouts, and durable duplicate checks.
  Hooks cannot override lifecycle safety. Installing or refreshing definitions runs no actions.
- Prove required/advisory tool coverage and duplicate-event hook handling in v1-ticket11 and
  v1-ticket12. Preserve accepted migration, reload, permission, and privacy checks as regressions.

## F13 - Measure factory effectiveness from evidence

As an operator, I can inspect delivery reliability, workflow delays, scorecards, and spending, so I
can improve the factory using observed outcomes rather than activity counts.

Priority: P1. Dependencies: F02, F03, F07, F12. Status: planned. See R16 and AC30-AC34 in
[prd.md](prd.md). The reference dashboard is conceptual inspiration, not a visual specification.

- Start with revision-bound delivery and CI records, first-pass success with evidence coverage,
  current check status, linked repairs, corrections, blocked time, and stage durations.
- Track PR outcomes when available and direct-commit deliveries without requiring PR creation.
  Preserve incomplete and abandoned work, unknown CI, observation windows, and explicit cohorts.
- Add versioned PR and test-suite scorecards with evidence and mandatory-gate results. Keep advisory
  model judgments separate; no single aggregate factory score or test-count proxy.
- Ingest authorized Amp thread usage through its supported API, without UI scraping. Preserve
  cumulative observations for period deltas, provider/model breakdown, source retention limits,
  missing records, and shared overhead. Keep BYOK estimates separate from Amp-reported usage.
- Read stored reports without model calls. Add no automatic evaluation, rerun, or self-modification.
- Prove failed-then-green CI, absent/stale checks, direct commits, duplicated/out-of-order events,
  changed rubrics, partial cost periods, child-thread attribution, and no-CI data refusal.

## Delivery order and proof

New required pipeline stories are tracked separately from the accepted pre-acceptance review slice:

- F15, scheduled full gates, P0, depends on F12 and native serialized landing. Preserve landed
  versus fully verified state, exact-revision attempts, restart safety and original-owner repair
  routing. [Local ticket](feats/scheduled-gates/scheduled-gates-ticket1.md). Status: scoped, not
  implemented.
- F16, conditional post-landing review, P0, depends on F15 and F12. Reuse cold opposite-family
  review without mandatory double review. Retain ownership and invalidate stale proof after repair.
  [Local ticket](feats/post-landing-review/post-landing-review-ticket1.md). Status: scoped, not
  built.
- F17, native discovery and intake, P1, depends on F12 and F04. Promote the fixture discovery
  contract into bounded native passes with mode changes, duplicate refusal, exhaustion, cooldown and
  evidence. PRD R2-R4 and AC1-AC12 remain the acceptance contract.
  [Local ticket](feats/native-discovery/native-discovery-ticket1.md). Status: not built natively.
- F18, coordinator-owned remote monitoring, P0 when publication is enabled, depends on F12 and F15.
  Implement durable push/PR correlation, native subscription reconciliation and original-owner
  repair under AC37-AC40. Local-only execution stays unchanged.
  [Local ticket](feats/remote-monitoring/remote-monitoring-ticket1.md). Status: not implemented.

Use [v1-execution.md](v1-execution.md) as the sole dispatch order. Do not recreate accepted setup,
worker effort, review, escalation, launcher, privacy, backup-command, or dashboard-integration work.
Keep existing checks when extending those capabilities. F13 needs stored delivery and usage
evidence before charts; F11 still requires preservation and replacement restore before retirement.

Each story needs its own observed acceptance evidence; the order above is not a completion claim.
Use small disposable fixtures and Luna workers for workflow trials. End with a cross-orb trial:
install, dispatch, reject and repair, accept, retain a lesson, back up, restore, and safely retire.
Keep the current no-live-Linear and no-production-change boundaries during these trials.

## Reuse from the earlier Claude dashboard

[Reviewed revision](https://github.com/mite404/claude-agent-dashboard/commit/8d03d4f). Reuse the
concepts in `src/db/schema.ts`, `src/db/index.ts`, `src/hooks/useTaskPolling.ts`, and
`src/components/GlobalEventStrip.tsx`: separate event records, Bun SQLite, small polling snapshots,
and compact event trails. Adapt to explicit Amp thread and ticket identities. Do not import the
Claude hook scripts or the frontend stack wholesale. Its task-field pause and retry controls do not
establish agent-process control; our command acknowledgments must describe actual effects.
