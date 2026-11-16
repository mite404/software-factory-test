# Remaining v1 execution

Reprioritized at `2c00930f414d29708ad022384d5c1912ce6b067a`, 2026-11-14. Local tickets only. This is
a scope inventory, not acceptance evidence or authorization for external actions.

## Count and order

The table below is the inventory; [backlog.md](backlog.md) counts what is open and done.
Public-title privacy (v1-ticket1), canonical backup adoption (backup-adoption-ticket1), and the
versioned definition (v1-ticket2) are accepted natively and no longer appear as implementation work
below. Historical ticket files remain as evidence. Feature numbers describe areas, not dispatch IDs.

The definition candidate is integrated into parent source and passed the combined gate. Watchdog
and safe admission have landed. The durability units and the dashboard and gate fixes below have
mostly landed too; evidence, recovery, and native execution follow. Service packaging and remaining
frontend acceptance follow those foundations. Dependencies are acceptance
prerequisites, not permission to dispatch every draft against today's base.

| Unit                                                                                    | Outcome                                                   | Prerequisites                                                            | Requirements                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| [v1-ticket1](feats/done/v1-ticket1.md)                                                  | Public titles never show private briefs                   | ticket-step-labels-ticket1                                               | F07                                       |
| [v1-ticket2](feats/done/v1-ticket2.md)                                                  | One versioned definition that never auto-runs             | backup-adoption-ticket1                                                  | F12                                       |
| [worktree-setup-ticket1](feats/done/worktree-setup-ticket1.md)                          | Each worktree is ready before its worker starts           | None                                                                     | F03                                       |
| [noninteractive-launcher-ticket1](feats/done/noninteractive-launcher-ticket1.md)        | Setup and gates ignore shell startup files                | worktree-setup-ticket1                                                   | F03                                       |
| [repair-escalation-ticket1](feats/done/repair-escalation-ticket1.md)                    | Escalated repairs resume on the same worker               | None                                                                     | F03                                       |
| [ticket-step-labels-ticket1](feats/done/ticket-step-labels-ticket1.md)                  | Dashboard shows ticket steps and target branch            | noninteractive-launcher-ticket1                                          | F07                                       |
| [foreman-watchdog-ticket1](feats/foreman-watchdog/foreman-watchdog-ticket1.md)          | Durable Foreman wake-up and incident identity             | v1-ticket2                                                               | F03, owner-approved supervision           |
| [foreman-watchdog-ticket2](feats/done/foreman-watchdog-ticket2.md)                      | Progress-based nudges and alert intent                    | foreman-watchdog-ticket1                                                 | F03, owner-approved supervision           |
| [foreman-watchdog-ticket3](feats/foreman-watchdog/foreman-watchdog-ticket3.md)          | Outside-orb wake-up and alert delivery                    | foreman-watchdog-ticket2                                                 | F03, owner-approved supervision           |
| [F001-backup-commit-identity](feats/done/F001-backup-commit-identity.md)                | Backup works under orb commit signing                     | backup-adoption-ticket1                                                  | F05, R13, operator durability priority    |
| [F002-worker-runner-executor](feats/done/F002-worker-runner-executor.md)                | Workers survive a Foreman CLI restart                     | v1-ticket2                                                               | F03, R8, operator autonomy priority       |
| [planned-intake-ticket1](feats/done/planned-intake-ticket1.md)                          | Planned backlog without accidental dispatch               | v1-ticket2, foreman-watchdog-ticket1                                     | F02, F07, owner-approved planning         |
| [F003-provider-limit-resume](feats/durability/F003-provider-limit-resume.md)            | Same threads resume after a provider limit                | foreman-watchdog-ticket3, F002-worker-runner-executor                    | F03, R8, operator autonomy priority       |
| [F004-keyed-creation-delivery](feats/done/F004-keyed-creation-delivery.md)              | Unclear creation and delivery recover by lookup           | F002-worker-runner-executor                                              | F03, R8, operator autonomy priority       |
| [F005-foreman-handoff](feats/done/F005-foreman-handoff.md)                              | Guarded same-orb Foreman takeover                         | foreman-watchdog-ticket3                                                 | F06, operator durability priority         |
| [F006-limit-fallback-setting](feats/done/F006-limit-fallback-setting.md)                | Wait or fall back on a provider limit                     | F003-provider-limit-resume                                               | F03, operator autonomy priority           |
| [F007-run-transition-table](feats/done/F007-run-transition-table.md)                    | One declared, tested run lifecycle table                  | F003 to F006                                                             | F03, F07, operator durability priority    |
| [F008-gate-failure-feedback](feats/done/F008-gate-failure-feedback.md)                  | A failed gate returns its output to the worker            | F003-provider-limit-resume                                               | F03, operator leverage priority           |
| [F009-attempt-cap-parking](feats/repair-escalation/F009-attempt-cap-parking.md)         | Twice-escalated ticket parks; queue continues             | F007-run-transition-table                                                | F03, operator autonomy priority           |
| [F010-brief-fact-check](feats/worker-feedback/F010-brief-fact-check.md)                 | No worker starts on an incomplete brief                   | F007-run-transition-table                                                | F02, F03                                  |
| [F011-step-actor-labels](feats/lifecycle-view/F011-step-actor-labels.md)                | Each step and exit names who performs it                  | F007, F016-kit-page-default                                              | F07                                       |
| [F012-lifecycle-graph-view](feats/lifecycle-view/F012-lifecycle-graph-view.md)          | Lifecycle drawn with tickets on their states              | F011, F014-lifecycle-stages                                              | F07                                       |
| [F013-event-log-drawer](feats/done/F013-event-log-drawer.md)                            | Live event log drawer and read-only trace API             | F016-kit-page-default                                                    | F07, operator observability priority      |
| [F014-lifecycle-stages](feats/lifecycle-view/F014-lifecycle-stages.md)                  | One named stage and actor for every run                   | F007, F009-attempt-cap-parking                                           | F07, operator observability priority      |
| [F015-weekly-failure-audit](feats/done/F015-weekly-failure-audit.md)                    | Weekly bucketed failures and a Fable audit                | F002-worker-runner-executor                                              | F04, operator quality priority            |
| [F016-kit-page-default](feats/done/F016-kit-page-default.md)                            | The kit page is the only dashboard                        | None                                                                     | F07, operator observability priority      |
| [F017-remove-public-status](feats/lifecycle-view/F017-remove-public-status.md)          | Feed carries the stage only                               | F012, F014-lifecycle-stages                                              | F07                                       |
| [F018-landed-card-links](feats/done/F018-landed-card-links.md)                          | Landed card opens its thread and pull request             | F016-kit-page-default                                                    | F07, operator observability priority      |
| [F019-gate-rerun-before-rejection](feats/done/F019-gate-rerun-before-rejection.md)      | A load flake in the gate does not reject                  | F008-gate-failure-feedback                                               | F03, operator autonomy priority           |
| [F020-reviewer-uses-ce-code-review](feats/done/F020-reviewer-uses-ce-code-review.md)    | Cold review uses the review skill                         | None                                                                     | F03, operator quality priority            |
| [F021-merge-record](feats/done/F021-merge-record.md)                                    | Each landed ticket records its pull request               | None                                                                     | F07, operator observability priority      |
| [F022-ticket-file-sync](feats/planned-intake/F022-ticket-file-sync.md)                  | Saved tickets appear as planned on their own              | planned-intake-ticket1                                                   | F02, F07, operator observability priority |
| [F023-public-stop-reasons](feats/lifecycle-view/F023-public-stop-reasons.md)            | A blocked or rejected ticket says why                     | None                                                                     | F07, operator observability priority      |
| [F024-serial-test-runs](feats/done/F024-serial-test-runs.md)                            | Test runs on one machine take turns                       | None                                                                     | F03, operator autonomy priority           |
| [F025-config-directory](feats/config-layout/F025-config-directory.md)                   | Factory settings live in one file per concern             | None                                                                     | F12, operator configuration priority      |
| [F026-factory-automations](feats/config-layout/F026-factory-automations.md)             | Automations switch on, off and run on demand              | F025-config-directory                                                    | F12, operator autonomy priority           |
| [F027-dashboard-controls](feats/config-layout/F027-dashboard-controls.md)               | The dashboard switches and runs automations               | F026-factory-automations                                                 | F07, F12, operator observability priority |
| [F028-role-credentials](feats/config-layout/F028-role-credentials.md)                   | Each role sees only its own credentials                   | F025-config-directory                                                    | F12, operator security priority           |
| [F029-gate-check-files](feats/config-layout/F029-gate-check-files.md)                   | The gate reports every check on its own                   | F025-config-directory                                                    | F03, F12, AC28                            |
| [F030-record-external-landing](feats/done/F030-record-external-landing.md)              | A ticket landed outside the factory counts as done        | None                                                                     | F03, operator autonomy priority           |
| [F031-landing-without-checkpoint](feats/done/F031-landing-without-checkpoint.md)        | A blocked run without a checkpoint can record its landing | F030-record-external-landing                                             | F03, operator autonomy priority           |
| [F032-landing-per-commit-proof](feats/done/F032-landing-per-commit-proof.md)            | A multi-commit candidate can record its landing           | F031-landing-without-checkpoint                                          | F03, operator autonomy priority           |
| [F033-provider-error-shape](feats/done/F033-provider-error-shape.md)                    | A real provider limit waits instead of stopping           | F006-limit-fallback-setting                                              | F03, operator autonomy priority           |
| [F034-reviewer-retry-create](feats/durability/F034-reviewer-retry-create.md)            | An interrupted reviewer creation can be retried           | F007-run-transition-table                                                | F03, operator autonomy priority           |
| [v1-ticket4](feats/v1/v1-ticket4.md)                                                    | Durable private evidence records                          | v1-ticket2                                                               | F02, F07, R6-R7                           |
| [v1-ticket11](feats/v1/v1-ticket11.md)                                                  | Required and advisory verification tools                  | v1-ticket2                                                               | F12, AC28, AC35-AC36                      |
| [v1-ticket12](feats/v1/v1-ticket12.md)                                                  | Permission-bound native hooks                             | v1-ticket11                                                              | F12, AC27, AC29                           |
| [scheduled-gates-ticket1](feats/scheduled-gates/scheduled-gates-ticket1.md)             | Landed versus fully checked revisions                     | v1-ticket11                                                              | F15, R7, AC35-AC36                        |
| [post-landing-review-ticket1](feats/post-landing-review/post-landing-review-ticket1.md) | One conditional review stage                              | scheduled-gates-ticket1                                                  | F16, R7, AC4, AC11                        |
| [v1-ticket5](feats/v1/v1-ticket5.md)                                                    | Relevant phase lessons                                    | v1-ticket4                                                               | F04, AC5, AC18                            |
| [v1-ticket6](feats/v1/v1-ticket6.md)                                                    | Snapshot evidence and phase checkpoints                   | backup-adoption-ticket1, v1-ticket5                                      | F05, R13, AC22-AC25                       |
| [v1-ticket7](feats/v1/v1-ticket7.md)                                                    | Validated replacement restore                             | v1-ticket6                                                               | F06, AC19, AC21                           |
| [v1-ticket8](feats/v1/v1-ticket8.md)                                                    | Exclusive orchestrator ownership                          | v1-ticket7                                                               | F06, AC23                                 |
| [v1-ticket9](feats/v1/v1-ticket9.md)                                                    | Exact cross-orb candidate transfer                        | v1-ticket4, v1-ticket8                                                   | F03, R5, AC2, AC19                        |
| [v1-ticket10](feats/v1/v1-ticket10.md)                                                  | Supported executor reconnection                           | v1-ticket2                                                               | F03, R8, AC8-AC9                          |
| [native-discovery-ticket1](feats/native-discovery/native-discovery-ticket1.md)          | Bounded evidence-backed intake                            | v1-ticket5, v1-ticket12                                                  | F17, R2-R4, AC1-AC12                      |
| [remote-monitoring-ticket1](feats/remote-monitoring/remote-monitoring-ticket1.md)       | Durable coordinator CI ownership                          | scheduled-gates-ticket1, v1-ticket12                                     | F18, AC37-AC40                            |
| [v1-ticket17](feats/v1/v1-ticket17.md)                                                  | Preservation-gated worker retirement                      | v1-ticket5, v1-ticket6, v1-ticket8, v1-ticket9                           | F11, AC24                                 |
| [v1-ticket15](feats/v1/v1-ticket15.md)                                                  | Ordered steering backend                                  | v1-ticket2, v1-ticket4                                                   | F10, R14                                  |
| [v1-ticket18](feats/v1/v1-ticket18.md)                                                  | Delivery and reliability measures                         | scheduled-gates-ticket1, remote-monitoring-ticket1, v1-ticket4           | F13, AC30-AC31, AC34                      |
| [v1-ticket19](feats/v1/v1-ticket19.md)                                                  | Versioned evidence scorecards                             | v1-ticket11, v1-ticket18                                                 | F13, AC32                                 |
| [v1-ticket20](feats/v1/v1-ticket20.md)                                                  | Authorized usage observations                             | v1-ticket2, v1-ticket18                                                  | F13, AC33                                 |
| [v1-ticket3](feats/v1/v1-ticket3.md)                                                    | Repeat-safe repository services                           | v1-ticket2                                                               | F01, AC13-AC16, AC20                      |
| [v1-ticket23](feats/v1/v1-ticket23.md)                                                  | Curated lifecycle feed and replay                         | v1-ticket1, v1-ticket4, planned-intake-ticket1, foreman-watchdog-ticket2 | F07, R9, AC17                             |
| [v1-ticket13](feats/v1/v1-ticket13.md)                                                  | Workbench evidence and actual lifecycle                   | v1-ticket23                                                              | F08, AC17, AC20                           |
| [v1-ticket14](feats/v1/v1-ticket14.md)                                                  | Protected dashboard backup command                        | v1-ticket6, v1-ticket13                                                  | F09, AC25                                 |
| [v1-ticket16](feats/v1/v1-ticket16.md)                                                  | Steering replies and delivery UI                          | v1-ticket13, v1-ticket15                                                 | F10, R14                                  |
| [v1-ticket21](feats/v1/v1-ticket21.md)                                                  | Read-only effectiveness views                             | v1-ticket13, v1-ticket19, v1-ticket20                                    | F13, AC30-AC34                            |
| [v1-ticket22](feats/v1/v1-ticket22.md)                                                  | Cross-orb v1 acceptance trial                             | All preceding units                                                      | R1-R16, AC1-AC40                          |

## Runtime admission

This ordered backlog is not the runtime queue. Until planned-intake-ticket1 lands, copying draft
units into `.factory-tickets.json` would make them dispatchable. Retain accepted records. Integrate
accepted v1-ticket2 without redispatching implementation, then admit each newly scoped ready unit
in the order above. Never change an active candidate's pinned base. Frontend entries are not next.
After planned intake is accepted, persist all remaining units as planned under these canonical IDs.
Promotion still needs a Foreman admission decision and accepted prerequisites.

## Execution contract shared by these tickets

The coordinator owns authored intake and dispatch. Workers edit only their assigned worktree. One
Sol 6.1 medium implementation owner runs at a time. Luna is for small workflow fixtures. Every
candidate runs the complete configured gate against its exact revision and current base. Required
opposite-family cold review and same-owner repair remain mandatory. Two rejected candidates cause a
Foreman checkpoint, not abandonment or automatic replacement.

Use existing modules before adding files. Future module names in tickets are proposals, not claims
of installed APIs. Revalidate the effective definition and allowed paths after dependencies land.
The pipeline-view integration is merged. Frontend tickets below cover remaining acceptance and
evidence work, not another frontend implementation or permission for concurrent writers.

No live remote pushes, private-repository provisioning, external ticket filing, production writes,
deployments, or worker-orb deletion are authorized. The approved watchdog scope permits its owned
Amp schedule and user alerts, not unrelated automations or hosted infrastructure. Use disposable
fixtures first. Permission-limited live acceptance stays visibly pending; passing a fixture cannot
close the corresponding live criterion.

## Dispatch preflight

Execute these in the exact prepared worktree before implementation, not while authoring tickets. No
baseline execution is claimed by this inventory. Preserve unrelated work and return setup failures
to the coordinator rather than expanding implementation scope.

| Command                                           | Required result                                       |
| ------------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                              | Record dispatch revision and accepted prerequisites.  |
| `git status --short`                              | Clean base or explicitly accounted unrelated changes. |
| `git diff --stat 62816cf..HEAD -- factory/ docs/` | Review committed prerequisite drift.                  |
| `git diff -- factory/`                            | No unexplained unstaged implementation changes.       |
| `git diff --cached -- factory/`                   | No unexplained staged implementation changes.         |
| `bun --version`                                   | Record actual supported toolchain.                    |
| `bun install --frozen-lockfile`                   | Prepare exact-worktree dependencies.                  |
| `bun test`                                        | Baseline tests pass without exclusions.               |
| `bun run lint:ci`                                 | Strict lint passes.                                   |
| `bun run typecheck`                               | Type check passes.                                    |
| `bun run format:check`                            | Formatting passes.                                    |
| `bun run fallow:ci`                               | Required analysis passes without suppressions.        |
| `git diff --check`                                | No whitespace errors.                                 |

After implementation repeat the full gate, run `bash factory/checks.sh guard`, and submit a clean
local commit with the current attempt's report. Save full logs privately outside tracked history.
Coordinator integration repeats gates in the parent. A passing worker gate is not acceptance. For UI
work, also render and inspect affected states and record changed interactions.

## Current frontier

The privacy regression passed native gates, cold review, and parent verification with 127 tests.
Public titles now use ticket IDs and review labels, not private briefs or observed thread titles.
Canonical backup adoption passed fresh cold review at attempt six. Backup, privacy, and dashboard
integration are merged through [PR #3](https://github.com/mite404/software-factory-test/pull/3).
The combined local gate passed 140 tests and all required checks; post-merge main CI passed.

Definition [v1-ticket2](feats/done/v1-ticket2.md) passed native gates and fresh cold review at
attempt four on candidate `901ae38e20fc3517170b43c8b9bea78f6920add1`. It was transferred from the
previous coordinator orb as a checksum-verified Git bundle, merged onto parent main by the Foreman,
and passed the combined gate with 150 tests. foreman-watchdog-ticket1 was then accepted natively at
attempt two and merged through PR #8; see workflow trial 11. foreman-watchdog-ticket2 was accepted
at attempt one and merged through PR #12; see workflow trial 12. foreman-watchdog-ticket3 was
accepted at attempt four and merged through PR #18; see workflow trial 13. Its live proof is still
pending: a scheduled wake of a sleeping orb and real alert delivery. The plugin tool bridge
installed and cleared a real schedule; see workflow trial 14. F001-backup-commit-identity was
accepted at attempt one, merged through PR #20, and proven live. F002-worker-runner-executor was
accepted at attempt one and merged through PR #23. Its live proof first failed and then passed after
PR #24; see workflow trial 15. planned-intake-ticket1 was accepted at attempt two on the runner and
merged through PR #25. F003-provider-limit-resume was accepted at attempt three and merged through
PR #31; see workflow trial 16. Its live proof at a real provider limit is still pending.
F008-gate-failure-feedback was accepted at attempt two: the first cold review found that the excerpt
held only the end of stderr, so a lint or type failure printed on stdout was lost. It has not yet
been seen on a real gate rejection. F016-kit-page-default was accepted at attempt one and makes the
kit page the only dashboard; its before and after screenshots are identical. planned-intake-ticket1
is done, so the planned inventory is imported.

Since then these tickets landed, each merged through its own integration pull request, and their
files are in `feats/done/`: F004, F005, F006 and F007 (PR #51, #56, #58, #63); F013 (#50); F015
(#54); F018 to F021 (#48, #45, #49, #43); F024 (#46); and F030 to F033 (#53, #59, #61, #62).
F003-provider-limit-resume is also merged, but its file stays outside `feats/done/` until its live
proof at a real provider limit happens.

F009 is running now. The operator set the order after it: F010, F011 and F014, then F012 and F017
as their dependencies allow, then F023, then F022, F025, F029, F026, F027 and F028 last. All are
placed. The factory runs one ticket at a time from merged main.

v1-ticket10 keeps the recovery of outages that still happen, and v1-ticket8 keeps exclusive
ownership across orbs. Keep preserved backup owners until required evidence preservation is
confirmed. Native acceptance does not authorize retirement.

Local sequential steel-thread evidence exists in workflow trials 8 and 9 and subsequent native
acceptances. Cross-orb transfer, replacement restore, remote monitoring, and retirement still need
their own proof. This inventory does not change that delivery state.

## Frontend requests

The pipeline-view owner requested twelve backend capabilities. Map them to this inventory rather
than adding a parallel feed or allowing browser inference:

- Same-origin dashboard and API integration: merged in PR #3. Repeat-safe repository service
  packaging remains v1-ticket3; a running supervised orb service does not complete that scope.
- A pushed branch and frontend history integration: satisfied by merged PR #3.
- Next-dispatch notice: coordinator sends it when actual native dispatch occurs.
- Short safe titles: accepted v1-ticket1. A ticket ID replaces private briefing text.
- Stage, check outcomes, review outcome, recorded skip reason, attempt, blocked reason, event
  replay, report receipts, and escalation references: v1-ticket23, sourced from durable transitions.
- Full gate runs: existing scheduled-gates-ticket1. Its box remains planned until acceptance.
- Planned counts and canonical identities: planned-intake-ticket1, extracted from v1-ticket23 so
  safe admission does not wait for richer replay or frontend work.
- Durable checkpoint identity and diagnosis: foreman-watchdog-ticket1. Stall timing, nudges and
  alert intent: foreman-watchdog-ticket2. The richer feed projects these facts in v1-ticket23.

New feed field names must be published after their implementation and tests, not promised as already
available. Public reasons and findings need curation; raw private reports stay private.

## Page placeholders

The dashboard is the kit page (F016). The operator's rule, 2026-11-15: anything on the page that
the factory does not report yet stays as a labelled placeholder until its ticket wires it. Do not
delete a placeholder and do not make one look live.

| Placeholder on the page                        | Shown today from              | Wired by                |
| ---------------------------------------------- | ----------------------------- | ----------------------- |
| Gate check ticks in the ticket sheet           | A fixed animation             | v1-ticket23             |
| Stages done per ticket                         | Inferred from `status`        | F014-lifecycle-stages   |
| Actor on each stage                            | Not shown                     | F011-step-actor-labels  |
| Notification list                              | Two polls compared            | F013-event-log-drawer   |
| Cold review with findings in the diagram       | The replay button only        | F014, then v1-ticket23  |
| Reports reaching the Foreman in the diagram    | The replay button only        | v1-ticket23             |
| Full gate box in the diagram                   | The replay button only        | scheduled-gates-ticket1 |
| Second line of a ticket tooltip                | The ticket's first step label | v1-ticket23             |
| Pull request number and arrow on a landed card | Not shown                     | F021, drawn by F018     |
