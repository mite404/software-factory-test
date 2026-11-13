# Architecture Decision Records

Factory decisions and trade-offs, oldest first. Preserve each record; append a dated amendment or
a new superseding record when a decision changes. Accepted means chosen, not implemented. Add dated
implementation commit links when verified code lands; never infer implementation from a docs commit.
These decisions are recorded on 2026-11-13 from the factory discussion and trials.

## ADR-001 - One execution thread owns one ticket

2026-11-13 - Accepted. Native factory implementation pending.
Keep implementation, debugging, review, and verification together until a ticket settles. Rejections
return to the same worker. Rejected: one ever-growing implementation thread or a new thread on every
retry. This preserves local debugging context but requires durable ticket-to-thread ownership.

## ADR-002 - The stronger orchestrator owns discovery and stories

2026-11-13 - Accepted. Production role configuration pending.
Use the higher-quality or higher-effort orchestrator for discovery, evidence assessment, stories,
and ticket authoring; workers implement bounded briefs. Thin means bounded coordination context,
not weak reasoning. Rejected: making cheap workers the default product planners. The cost is more
expensive discovery turns; improved output quality still needs measurement.

## ADR-003 - Events advance work; schedules recover it

2026-11-13 - Accepted. Native event-driven dispatch pending.
Programmatic completion events and durable state drive dispatch. Scheduled reconciliation recovers
missed progress; it is not the main loop. Rejected: reminder threads and model-interpreted capacity
or duplicate checks. The cost is explicit state transitions and remote-creation reconciliation.
No schedule or missing configuration silently grants permission to discover new work.

## ADR-004 - Durable records carry context between tickets

2026-11-13 - Accepted. Automatic insight routing pending.
Pass ticket records, relevant PRD sections, dependency results, and scoped evidence references.
Keep full logs outside coordinator context. Rejected: copying transcripts into each worker, which
accumulates unrelated history. The cost is maintaining accurate summaries and routing verified
discoveries to affected workers.

## ADR-005 - Acceptance belongs to a verified revision

2026-11-13 - Accepted. Native acceptance integration pending.
Require revision-bound acceptance evidence before completion. Reject `agent.end` and final prose as
proof: `action-checks.ts` can request continuation, and plugin handler order is undefined. This adds
verification bookkeeping but prevents stale or unfinished work from releasing dependent tickets.

## ADR-006 - Separate evidence extraction from bug-rating rules

2026-11-13 - Accepted. Scratch prototype only; production integration pending.
The orchestrator interprets evidence; code applies explicit rating and filing rules. The first Luna
judge disagreed with three fixture expectations; categorical extraction plus `rate.py` matched all
five. Rejected: unconstrained prose ratings. The cost is a maintained rubric, and evidence can still
be misinterpreted. Fix scope, blast radius, and blocked status remain separate.

## ADR-007 - Reuse bookkeeping and checks without assuming they dispatch

2026-11-13 - Accepted direction. Native integration pending.
Reuse poteto's orchestration store and model-agnostic action-checks hooks rather than fork their
implementations. The store provides bookkeeping, not worker creation. Probes passed unchanged;
durable dispatch reconciliation still belongs to the factory. The cost is an explicit integration
boundary whose supported APIs and lifecycle must be tested.
See [trial evidence](workflow-trials.md).

## ADR-008 - Setup configures a repository; starting work is separate

2026-11-13 - Proposed. Installer and native runtime pending.
Use a repeatable `setup-factory` entry point with a check-only mode. Keep configuration versioned,
runtime state separate, and execution disabled after setup. Rejected: an installer that also starts
workers or enables schedules. The cost is a separate start action, which keeps installation from
silently authorizing work. Distribution and installation paths remain open until native dispatch
is proven in a second repository.

## ADR-009 - Builders isolate changes; one integrator lands them

2026-11-13 - Accepted boundary. Native implementation in progress.
Give each builder a branch and worktree; serialize integration and return corrections to its owner.
Rejected: workers committing directly into the integration checkout. Isolation costs worktree
lifecycle bookkeeping but keeps unfinished work out of accepted state. The pipeline separates
landing checks from a scheduled full gate and risky-change review, following
[Kit Langton's example](https://x.com/kitlangton/status/2119860603229724930). Those later stages
remain unimplemented in the native slice; no fast lane is authorized by the diagram alone.

## ADR-010 - Run in the coordinator orb with SQLite

2026-11-13 - Accepted direction. Database, dashboard, and restore implementation pending.
Install into the existing repository's Amp orb, not a separate cloud deployment per project.
Keep coordinator state and project memory in SQLite and return JSON through the coordinator API.
Expose one dashboard origin through an Amp portal; Vite may proxy API requests during development.
Rejected: requiring a local laptop service or browser access to worker files. SQLite replaces the
prototype's file persistence, not a second source of truth. Orb deletion requires an external,
consistent checkpoint and tested restore; the storage destination remains undecided. A supervised
service or portal does not make a paused orb always-on.

2026-11-13 - Clarification. Package the factory as a repo-contained app service, like Storybook.
Version its tool files and service configuration alongside the application. Keep SQLite runtime
data inside the checkout, separate from versioned configuration. This does not require a globally
installed tool or a separate deployment. Backup policy for the live database remains open.

## ADR-011 - Save phase lessons, retrieve only relevant evidence

2026-11-13 - Accepted direction. Summary persistence and retrieval pending.
Record findings, encountered bugs, failed approaches, self-corrections, and open questions after
substantial phases. Key records by project, phase, and source revision with thread and evidence
links.
Retrieve scoped lessons for later work rather than replay transcripts. Rejected: treating generated
summaries as verified truth or acceptance evidence. This costs evidence review and supersession
tracking but preserves useful corrections without growing every worker's prompt indefinitely.

## ADR-012 - Back up project state to a separate private repository

2026-11-13 - Accepted direction. Snapshot and restore implementation pending.
Resolve ADR-010's backup destination: keep the live SQLite database git-ignored in the application
repo and push consistent snapshots to a separate private GitHub repo, keyed by stable project
identity. One private repo may serve several projects. Only the orchestrator has backup access.
Restore and validate the latest confirmed snapshot before replacement-orb dispatch; failed access
must not reset history. Reject conflicting updates without force-pushing or merging SQLite files.
Enforce one active orchestrator per project; rejected Git pushes alone do not enforce ownership.
Backup permission is separate from application publishing permission. Rejected: private memory in
public application history or a hosted database per project. Git suits small phase-level snapshots,
but binary history grows and work since the last confirmed push remains unprotected. Retention and
size limits remain open. No private repo creation or push is authorized by this decision alone.

2026-11-13 - Command boundary. `factory backup`, the dashboard's **Back up now** button, and
authorized phase checkpoints call one deterministic backend operation. The button uses a protected
POST endpoint; credentials and destination configuration stay server-side. Serialize duplicate
requests and report success only after remote confirmation. No model call or application push is
part of this operation. Command, endpoint, and button implementation remain pending.

## ADR-013 - Preserve accepted work before retiring worker orbs

2026-11-13 - Accepted direction. Worker retirement implementation pending.
Keep the factory service and database in the orchestrator orb. Retire disposable workers only after
revision-bound verification, integration, preservation of code and required evidence outside the
worker orb, and confirmed private backup of the accepted outcome and lessons. Pending corrections
return to the same worker. Failed backup or missing delivery permission blocks retirement without
granting publishing rights. Record retirement separately and make cleanup idempotent. Rejected:
archiving on an idle turn or leaving evidence only in the deleted orb. Retaining a worker longer
costs resources but avoids losing recoverable work; archival is not itself proof of acceptance.

## ADR-014 - Use native Amp events and a single steering target

2026-11-13 - Accepted direction. Native observations exist in the prototype; chat is pending.
Subscribe to Amp thread state and title events, keeping the factory independent of model and
provider. Reconcile missed observations without model calls. Reject provider-specific hooks and
idle-as-acceptance rules. V1 dashboard chat appends only to one configured orchestrator thread
through a protected backend endpoint. Reject arbitrary browser-selected targets and client-side
Amp credentials. Durable request IDs and explicit uncertain-delivery states are required because
retries can otherwise send the same steering instruction twice.

## ADR-015 - Projects own declarative factory definitions

2026-11-13 - Accepted direction. Schema, migration, and runtime loading are not implemented.
Keep the engine shared and project-specific factory behavior in versioned repository files. Use
YAML for operational declarations, Markdown for agent instructions and notes, and JSON for schemas
and machine contracts. Each value has one authoritative home. Reuse existing service definitions
rather than copy them into a second configuration system. Exact paths remain an implementation
decision; `.factory.json` continues to work until an explicit migration is implemented.

The backend validates and resolves one effective definition for execution and frontend capability
display. Pin its revision or digest to worker runs. Reload changes future work, not active ownership
or acceptance gates. Hooks use supported native events and bounded, permission-checked actions;
they cannot replace engine safety rules. Setup and refresh do not execute declared actions.

Rejected: per-project engine forks, configuration duplicated across backend and frontend, and
encoding the entire engine or arbitrary UI layouts in YAML. Schema validation and migration add
maintenance, but keep supported customization explicit and upgrades reviewable. Public-safe
definitions stay separate from private runtime memory and secrets. See R15 and backlog F12.
