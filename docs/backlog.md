# Factory ticket backlog

Generated from the "Done when" boxes in each ticket file; do not edit by hand. A ticket is done
when every box is ticked, and then its file moves to `feats/done/`. Tickets are local, not Linear
issues, and listing one here does not authorize dispatch. The live queue and each ticket's current
status come from the factory database, shown on the dashboard; this file is the written record.

User stories are in [stories.md](stories.md), requirements in the [PRD](prd.md), and dependencies
and admission rules in [v1-execution.md](v1-execution.md).

## Landed with open boxes (6)

Merged, but at least one box, usually a live proof, is still open.

| Ticket | Outcome | Done when |
| --- | --- | --- |
| [foreman-watchdog-ticket1](feats/foreman-watchdog/foreman-watchdog-ticket1.md) | Durable Foreman wake-up and incident identity | 4/5 |
| [foreman-watchdog-ticket3](feats/foreman-watchdog/foreman-watchdog-ticket3.md) | Outside-orb wake-up and alert delivery | 2/4 |
| [F003-provider-limit-resume](feats/durability/F003-provider-limit-resume.md) | Same threads resume after a provider limit | 5/6 |
| [F011-step-actor-labels](feats/lifecycle-view/F011-step-actor-labels.md) | Each step and exit names who performs it | 5/6 |
| [F023-public-stop-reasons](feats/lifecycle-view/F023-public-stop-reasons.md) | A blocked or rejected ticket says why | 5/6 |
| [v1-ticket3](feats/v1/v1-ticket3.md) | Repeat-safe repository services | 1/3 |

## Not started (24)

In dispatch order.

| Ticket | Outcome | Done when |
| --- | --- | --- |
| [F028-role-credentials](feats/config-layout/F028-role-credentials.md) | Each role sees only its own credentials | 0/3 |
| [v1-ticket12](feats/v1/v1-ticket12.md) | Permission-bound native hooks | 0/3 |
| [scheduled-gates-ticket1](feats/scheduled-gates/scheduled-gates-ticket1.md) | Landed versus fully checked revisions | 0/4 |
| [F022-ticket-file-sync](feats/planned-intake/F022-ticket-file-sync.md) | Saved tickets appear as planned on their own | 0/6 |
| [v1-ticket10](feats/v1/v1-ticket10.md) | Supported executor reconnection | 0/3 |
| [v1-ticket5](feats/v1/v1-ticket5.md) | Relevant phase lessons | 0/3 |
| [v1-ticket6](feats/v1/v1-ticket6.md) | Snapshot evidence and phase checkpoints | 0/3 |
| [v1-ticket7](feats/v1/v1-ticket7.md) | Validated replacement restore | 0/3 |
| [v1-ticket8](feats/v1/v1-ticket8.md) | Exclusive orchestrator ownership | 0/3 |
| [v1-ticket9](feats/v1/v1-ticket9.md) | Exact cross-orb candidate transfer | 0/3 |
| [v1-ticket15](feats/v1/v1-ticket15.md) | Ordered steering backend | 0/3 |
| [v1-ticket23](feats/v1/v1-ticket23.md) | Curated lifecycle feed and replay | 0/6 |
| [v1-ticket13](feats/v1/v1-ticket13.md) | Workbench evidence and actual lifecycle | 0/3 |
| [post-landing-review-ticket1](feats/post-landing-review/post-landing-review-ticket1.md) | One conditional review stage | 0/5 |
| [native-discovery-ticket1](feats/native-discovery/native-discovery-ticket1.md) | Bounded evidence-backed intake | 0/5 |
| [remote-monitoring-ticket1](feats/remote-monitoring/remote-monitoring-ticket1.md) | Durable coordinator CI ownership | 0/5 |
| [v1-ticket17](feats/v1/v1-ticket17.md) | Preservation-gated worker retirement | 0/3 |
| [v1-ticket18](feats/v1/v1-ticket18.md) | Delivery and reliability measures | 0/3 |
| [v1-ticket19](feats/v1/v1-ticket19.md) | Versioned evidence scorecards | 0/3 |
| [v1-ticket20](feats/v1/v1-ticket20.md) | Authorized usage observations | 0/3 |
| [v1-ticket14](feats/v1/v1-ticket14.md) | Protected dashboard backup command | 0/3 |
| [v1-ticket16](feats/v1/v1-ticket16.md) | Steering replies and delivery UI | 0/3 |
| [v1-ticket21](feats/v1/v1-ticket21.md) | Read-only effectiveness views | 0/3 |
| [v1-ticket22](feats/v1/v1-ticket22.md) | Cross-orb v1 acceptance trial | 0/3 |

## Deferred until the user asks (1)

Written up but set aside; not dispatched until the operator asks for it.

| Ticket | Outcome | Done when |
| --- | --- | --- |
| [F036-context-window-reminders](feats/worker-budgets/F036-context-window-reminders.md) | Context-window reminders with an operator-chosen handoff | 0/5 |

## Done (43)

| Ticket | Outcome | Done when |
| --- | --- | --- |
| [foreman-watchdog-ticket2](feats/done/foreman-watchdog-ticket2.md) | Progress-based nudges and alert intent | 4/4 |
| [F001-backup-commit-identity](feats/done/F001-backup-commit-identity.md) | Backup works under orb commit signing | 5/5 |
| [F002-worker-runner-executor](feats/done/F002-worker-runner-executor.md) | Workers survive a Foreman CLI restart | 6/6 |
| [planned-intake-ticket1](feats/done/planned-intake-ticket1.md) | Planned backlog without accidental dispatch | 4/4 |
| [F008-gate-failure-feedback](feats/done/F008-gate-failure-feedback.md) | A failed gate returns its output to the worker | 5/5 |
| [F016-kit-page-default](feats/done/F016-kit-page-default.md) | The kit page is the only dashboard | 5/5 |
| [F021-merge-record](feats/done/F021-merge-record.md) | Each landed ticket records its pull request | 5/5 |
| [F019-gate-rerun-before-rejection](feats/done/F019-gate-rerun-before-rejection.md) | A load flake in the gate does not reject | 6/6 |
| [F018-landed-card-links](feats/done/F018-landed-card-links.md) | Landed card opens its thread and pull request | 7/7 |
| [F020-reviewer-uses-ce-code-review](feats/done/F020-reviewer-uses-ce-code-review.md) | Cold review uses the review skill | 5/5 |
| [F013-event-log-drawer](feats/done/F013-event-log-drawer.md) | Live event log drawer and read-only trace API | 6/6 |
| [F015-weekly-failure-audit](feats/done/F015-weekly-failure-audit.md) | Weekly bucketed failures and a Fable audit | 6/6 |
| [F004-keyed-creation-delivery](feats/done/F004-keyed-creation-delivery.md) | Unclear creation and delivery recover by lookup | 5/5 |
| [F030-record-external-landing](feats/done/F030-record-external-landing.md) | A ticket landed outside the factory counts as done | 5/5 |
| [F005-foreman-handoff](feats/done/F005-foreman-handoff.md) | Guarded same-orb Foreman takeover | 6/6 |
| [F006-limit-fallback-setting](feats/done/F006-limit-fallback-setting.md) | Wait or fall back on a provider limit | 5/5 |
| [F007-run-transition-table](feats/done/F007-run-transition-table.md) | One declared, tested run lifecycle table | 5/5 |
| [F009-attempt-cap-parking](feats/done/F009-attempt-cap-parking.md) | Twice-escalated ticket parks; queue continues | 6/6 |
| [F037-two-worker-lanes](feats/done/F037-two-worker-lanes.md) | Two lanes run two tickets at once | 5/5 |
| [F014-lifecycle-stages](feats/done/F014-lifecycle-stages.md) | One named stage and actor for every run | 6/6 |
| [F035-observer-watchdog-thread](feats/done/F035-observer-watchdog-thread.md) | Routine watchdog checks run in a cheap observer thread | 5/5 |
| [F010-brief-fact-check](feats/done/F010-brief-fact-check.md) | No worker starts on an incomplete brief | 4/4 |
| [F012-lifecycle-graph-view](feats/done/F012-lifecycle-graph-view.md) | Lifecycle drawn with tickets on their states | 6/6 |
| [F017-remove-public-status](feats/done/F017-remove-public-status.md) | Feed carries the stage only | 3/3 |
| [F025-config-directory](feats/done/F025-config-directory.md) | Factory settings live in one file per concern | 7/7 |
| [F029-gate-check-files](feats/done/F029-gate-check-files.md) | The gate reports every check on its own | 6/6 |
| [F026-factory-automations](feats/done/F026-factory-automations.md) | Automations switch on, off and run on demand | 5/5 |
| [v1-ticket11](feats/done/v1-ticket11.md) | Required and advisory verification tools | 3/3 |
| [F027-dashboard-controls](feats/done/F027-dashboard-controls.md) | The dashboard switches and runs automations | 5/5 |
| [F040-landing-chronicles](feats/done/F040-landing-chronicles.md) |  | 5/5 |
| [F024-serial-test-runs](feats/done/F024-serial-test-runs.md) | Test runs on one machine take turns | 5/5 |
| [F031-landing-without-checkpoint](feats/done/F031-landing-without-checkpoint.md) | A blocked run without a checkpoint can record its landing | 5/5 |
| [F032-landing-per-commit-proof](feats/done/F032-landing-per-commit-proof.md) | A multi-commit candidate can record its landing | 4/4 |
| [F033-provider-error-shape](feats/done/F033-provider-error-shape.md) | A real provider limit waits instead of stopping | 4/4 |
| [F034-reviewer-retry-create](feats/done/F034-reviewer-retry-create.md) | An interrupted reviewer creation can be retried | 5/5 |
| [v1-ticket4](feats/done/v1-ticket4.md) | Durable private evidence records | 3/3 |
| [v1-ticket1](feats/done/v1-ticket1.md) | Public titles never show private briefs | 3/3 |
| [v1-ticket2](feats/done/v1-ticket2.md) | One versioned definition that never auto-runs | 4/4 |
| [worktree-setup-ticket1](feats/done/worktree-setup-ticket1.md) | Each worktree is ready before its worker starts | 5/5 |
| [noninteractive-launcher-ticket1](feats/done/noninteractive-launcher-ticket1.md) | Setup and gates ignore shell startup files | 4/4 |
| [repair-escalation-ticket1](feats/done/repair-escalation-ticket1.md) | Escalated repairs resume on the same worker | 5/5 |
| [ticket-step-labels-ticket1](feats/done/ticket-step-labels-ticket1.md) | Dashboard shows ticket steps and target branch | 6/6 |
| [F038-kimi-k3-reviewers](feats/done/F038-kimi-k3-reviewers.md) |  | 6/6 |
