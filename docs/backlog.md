# Factory implementation backlog

Updated 2026-11-14. These are local user stories, not filed Linear tickets. No story authorizes
remote provisioning, pushes, application delivery, or worker deletion. Status describes observed
implementation, not acceptance of the design. See [PRD](prd.md) and [decisions](adr.md).

The [remaining v1 execution inventory](v1-execution.md) scopes 32 acceptance units, including 27
bounded tickets and five reused tickets. It is the current dispatch/dependency plan; historical
feature stories below retain their evidence and may describe superseded sequencing. Public-title
privacy (v1-ticket1) and canonical backup adoption are accepted natively; 30 remain. No extra
execution or remote permission is granted by the inventory.

Core-first order after accepted backup adoption: definition v1-ticket2, three
[Foreman watchdog tickets](feats/foreman-watchdog/foreman-watchdog-ticket1.md), then
[safe planned intake](feats/planned-intake/planned-intake-ticket1.md). Evidence, gates, recovery and
native execution follow; service/frontend acceptance comes afterward. The owner approved this
priority and the watchdog's owned Amp schedule/user alerts, not unrelated external infrastructure.
Only definition v1-ticket2 is next for runtime admission. Full ordering and admission rules live in
the inventory, not in these older feature narratives.

## F01 - Install the factory as a repository service

As an operator, I can install and check the factory in an existing repo without changing my app or
starting workers, so I can adopt it project by project.

Priority: P0. Dependencies: none. Status: install and explicit refresh verified locally; service
packaging incomplete.

First bounded ticket: [feature 01 story](features/feature-01/feature-01-story.md) and
[worker implementation ticket](features/feature-01/feature-01-impl.md). Expand later backlog items
into the same paired format when they become the next implementation unit.

The [feature 02 story](features/feature-02/feature-02-story.md) and
[implementation ticket](features/feature-02/feature-02-impl.md) add explicit worker effort before
further implementation. Implementation workers use Sol 6.1 at medium effort, one child at a time.
Luna remains available for inexpensive workflow fixtures.

The [feature 06 story](features/feature-06/feature-06-story.md) and
[implementation ticket](features/feature-06/feature-06-impl.md) add conditional cold post-graft
review. This is the accepted workflow prerequisite, not backlog F06 restore. Scope: Large. Blast
radius: elevated, because reviewer ownership, acceptance, retries, and SQLite recovery must agree.
Prove that absent or stale review cannot land work or dispatch a dependent, including reload. Its
live rejection/repair lifecycle passed trial 9; backup/restore acceptance remains separate.

- Setup preserves app files, guidance, configuration, and existing runtime data on repeat runs.
- Install the coordinator adapter and dashboard service alongside the project, with documented start
  commands and Amp supervised service configuration.
- Check mode reports missing prerequisites without writes or model calls. Execution remains off.
- The same installation works in two disposable repos without source edits or remote provisioning.

## F02 - Persist coordinator state in SQLite

As an operator, I can restart the factory without losing its queue, ownership, or history, so
recovery does not depend on a model remembering the previous conversation.

Priority: P0. Dependencies: F01. Status: core SQLite persistence and legacy migration verified in
[Feature 04](features/feature-04/feature-04-impl.md). Evidence and lessons still use existing
storage.

- Use Bun SQLite with versioned migrations and separate records for projects, tickets, worker runs,
  events, evidence, and lessons. Preserve explicit thread and revision correlation.
- Persist each state transition and its event atomically. Enforce unique ticket claims.
- Migrate existing prototype records without erasing them. Invalid or incompatible data fails
  visibly rather than becoming an empty database.
- Restart reconciliation does not repeat ambiguous creation, message delivery, or integration.
- Live database files and journals remain git-ignored; public application history stays clean.

## F03 - Connect the coordinator to Amp

As an operator, I can bind the factory to one orchestrator thread and observe its workers, so
execution and the dashboard agree about which agents own the work.

Priority: P0. Dependencies: F01, F02. Status: native local-worker adapter prototype only. Feature 02
model and effort forwarding and Feature 03 explicit disconnected-worker reconciliation passed live
acceptance. The status fallback uses a supported Amp tool without model calls. Verification is
asynchronous so it does not starve the plugin heartbeat. Automatic local executor reattachment
remains unimplemented; resuming the same disconnected worker required authorized CLI continuation.
Idle remains an observation, not acceptance. The F14 cold reviewer also lost its executor after the
coordinator CLI received SIGTERM on 2026-11-13 at 15:04 UTC. Authorized CLI recovery later produced
a verdict; observation reattachment alone did not reconnect its tools. Why the coordinator CLI was
terminated remains unverified.

- Store one orchestrator thread ID per project. V1 does not offer an arbitrary thread selector.
- Observe native Amp thread state and titles without model calls. Distinguish idle, running,
  awaiting approval, and errors from acceptance.
- Use Amp-native event subscriptions and supported APIs, independent of model or provider. Do not
  depend on Claude hooks, provider-specific payloads, or parsing assistant prose for lifecycle
  state.
- Reattach observations on restart and distinguish unavailable observations from idle workers.
- For separate worker orbs, prove exact code transfer and return of revision-bound evidence.
  Existing local worktree trials do not prove cross-orb execution.
- Dispatch remains permission-gated and sequential. Recovery retains the same worker on rejection.
- Every two failed candidates require a recorded Foreman decision, not a terminal attempt limit.
  [Repair escalation](feats/repair-escalation/repair-escalation-ticket1.md) has passed local gates;
  native same-worker repair and fresh cold review are accepted and integrated locally.

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

Priority: P0. Dependencies: F02. Status: local backup candidate preserved; refresh against current
prerequisites and canonical integration remain pending. No private repo has been provisioned.

- Configure a private state repo and a stable project key. Several projects may share that repo.
- Require backup permission separately from application publishing permission. Credentials stay
  server-side and are not included in snapshots or worker briefs.
- Create a consistent SQLite snapshot, including project identity, schema, and source revisions.
  Preserve required private evidence alongside it or through durable protected references.
- Serialize requests. No-op unchanged snapshots; never force-push or merge conflicting databases.
- Confirm the remote commit before reporting success. Ambiguous outcomes are reconciled first.
- Show pending, failed, and last-confirmed backup state; disclose that later local work is unbacked.

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

Priority: P0. Dependencies: F02, F03. Status: SQLite-backed read-only projection accepted in local
dogfood, including cold review and same-worker repair. See [trial 9](workflow-trials.md). Evidence
browsing and cross-orb proof remain pending.

- Return allowed fields for tickets, accurate titles, thread links, revisions, activity, evidence,
  and observation time. Do not return raw database files, private config, or credentials.
- A missing or stale source is explicit and never reported as current activity.
- Use an authenticated Amp portal and same-origin API requests. Development may use a Vite proxy;
  the built frontend needs no separate Vite process.
- Expose explicit commands separately from reads. Reject arbitrary state mutations and file paths.

## F08 - Show the abstract factory workbench

As an operator, I can see named work and its status in a minimal animated pipeline, so I can
understand activity without reading every thread.

Priority: P1. Dependencies: F07. Status: first frontend browser-verified against disposable state
and labeled samples. The SQLite API passed trial 9; full evidence views remain pending.

- Show builders, handoff, serialized integration, accepted work, and the same-owner correction path.
- Actual ticket, commit, PR, and thread names come from recorded sources where available. Do not
  invent missing names or links. Explicit sample mode is labeled as illustrative, never live data.
- Loop lightweight motion while a fresh observation says a thread is working. Do not drive motion
  frame by frame from database events or imply measured progress through pipeline stages.
- Stop activity motion for idle, blocked, disconnected, or stale observations. Support reduced
  motion and a manual motion toggle.
- Selecting work shows its identity and available evidence links. Verify narrow layouts, keyboard
  access, long names, empty queues, stale status, and active work in a real browser.

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

Priority: P0. Dependencies: F01, F03. Status: planned. See R15 and AC26-AC29 in [prd.md](prd.md).
Existing `.factory.json`, service declarations, and Markdown prompts are starting points.

- Define the supported configuration contract for backend services, runners, commands, agent roles,
  verification, discovery, native lifecycle hooks, and dashboard capabilities.
- Discover existing `action-checks`, `ci-watch`, and `verify-<project-name>` capabilities. Reuse
  pstack-created app harnesses and applicable formal-verification checks, with required/advisory
  roles and explicit coverage. Do not create replacement tools or duplicate CI watchers by default.
- Use YAML for authored operations, Markdown for agent instructions and notes, and JSON for schemas
  and machine contracts. Give each setting one home. Choose paths and schema during implementation.
- Resolve one validated effective configuration for backend and frontend. Provide a no-side-effect
  check and a secret-free configuration view, with explicit errors for unsupported capabilities.
- Keep runtime SQLite, private memory, secrets, generated adapters, and observations out of authored
  configuration. Workers receive scoped briefs, not privileged project settings.
- Pin definition content to runs. Explicit reload affects future work without changing active scope
  or gates. Upgrade preserves project edits; migrate existing installs without permission changes.
- Bound hook actions by native event identity, permissions, timeouts, and durable duplicate checks.
  Hooks cannot override lifecycle safety. Installing or refreshing definitions runs no actions.
- Prove customization in two disposable projects, invalid-definition refusal, safe repeat setup,
  reload during active work, backend/frontend agreement, and duplicate-event hook handling.

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

## F14 - Prepare dependencies in every worker worktree

As an operator, I can dispatch a worker into a fully prepared worktree, so baseline gates do not
depend on tools or package metadata borrowed from an ancestor checkout.

Priority: P0. Dependencies: F01, F03. Status: attempt three accepted through native staging and
fresh cold review. All gates and guard passed with 115 tests. The exact accepted factory files
passed parent gates and were committed locally as `f8eda06`; nothing has been pushed.

- Run the project's declared setup in the exact worker worktree before delivering implementation
  work. Use the locked dependency installation; do not assume orb setup prepares later worktrees.
- Persist setup outcome and logs. Failed setup blocks dispatch with coordinator-owned evidence;
  recovery retains the same worktree and worker without consuming a code-correction attempt.
- Make restart recovery safe after partial setup without repeating ambiguous worker creation.
- Prove a fresh worktree, repeated setup, setup failure/recovery, and independence from ancestor
  dependencies. Retain the project's required gates without ignores or weakened thresholds.
- Regression evidence: feature-07 had no local `node_modules`; Fallow 3.42.0 ran from the ancestor
  installation but flagged `@ampcode/cli` as unused. In the unchanged, clean worker checkout,
  `bun install --frozen-lockfile` changed `bun run fallow:ci` from exit 1 to exit 0. The original
  repair was manual. Automatic preparation is now accepted and integrated locally.

The next native dispatch exposed socket-backed command stdin causing nested Bash to reset Bun's
dependency paths. Explicit `retry-setup` recovered the same worktree at implementation attempt one.
[Shared-launcher repair](feats/noninteractive-launcher/noninteractive-launcher-ticket1.md) is now
accepted through same-worker repair and fresh cold review. Parent verification passed 123 tests, all
gates and guard. Ordinary setup and verification commands no longer need stdin redirections.

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

[Repair escalation](feats/repair-escalation/repair-escalation-ticket1.md) is accepted through native
attempt-two verification and fresh cold review. Parent verification passed 117 tests, all gates and
guard. Two rejections now preserve an owner-resumable checkpoint rather than a terminal cap. The
shared-launcher repair is also accepted and integrated locally. Re-scope each later ticket against
accepted prerequisites.

Finish the existing sequential setup and dispatch trial first. Build F02 and F03 as the persistence
and Amp foundation, then F05 and F06 for safe recovery. F04, F07, and F08 provide usable memory and
visibility. F09 and F10 add explicit controls. F11 follows once preservation and restore are proven.

Scope F12 after the active backup ticket and before expanding installation and dashboard controls.
First define the shared contract and migration boundary; implement capabilities in bounded tickets
as their underlying features become available. Do not create a second concurrent worker or rewrite
the active backup ticket to introduce this configuration format.

Build F13 in bounded slices after the observation API and definition contract. Collect source
evidence before adding charts or comparing factories; do not start another implementation worker
while the current backup ticket is active.

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
