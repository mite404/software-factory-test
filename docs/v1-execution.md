# Remaining v1 execution

Reprioritized at `2c00930f414d29708ad022384d5c1912ce6b067a`, 2026-11-14. Local tickets only. This is
a scope inventory, not acceptance evidence or authorization for external actions.

## Count and order

The inventory contains 29 remaining acceptance units from the original 32. Public-title privacy
(v1-ticket1), canonical backup adoption (backup-adoption-ticket1), and the versioned definition
(v1-ticket2) are accepted natively and no longer appear as implementation work below. Historical
ticket files remain as evidence. Feature numbers describe areas, not dispatch IDs.

The definition candidate is integrated into parent source and passed the combined gate. Next come
watchdog and safe admission, followed by evidence, gates, recovery, and native execution. Service
packaging and remaining frontend acceptance follow those foundations. Dependencies are acceptance
prerequisites, not permission to dispatch every draft against today's base.

| Unit                                                                                    | Outcome                                       | Prerequisites                                                            | Requirements                           |
| --------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| [foreman-watchdog-ticket1](feats/foreman-watchdog/foreman-watchdog-ticket1.md)          | Durable Foreman wake-up and incident identity | v1-ticket2                                                               | F03, owner-approved supervision        |
| [foreman-watchdog-ticket2](feats/foreman-watchdog/foreman-watchdog-ticket2.md)          | Progress-based nudges and alert intent        | foreman-watchdog-ticket1                                                 | F03, owner-approved supervision        |
| [foreman-watchdog-ticket3](feats/foreman-watchdog/foreman-watchdog-ticket3.md)          | Outside-orb wake-up and alert delivery        | foreman-watchdog-ticket2                                                 | F03, owner-approved supervision        |
| [F001-backup-commit-identity](feats/backup-identity/F001-backup-commit-identity.md)     | Backup works under orb commit signing         | backup-adoption-ticket1                                                  | F05, R13, operator durability priority |
| [planned-intake-ticket1](feats/planned-intake/planned-intake-ticket1.md)                | Planned backlog without accidental dispatch   | v1-ticket2, foreman-watchdog-ticket1                                     | F02, F07, owner-approved planning      |
| [v1-ticket4](feats/v1/v1-ticket4.md)                                                    | Durable private evidence records              | v1-ticket2                                                               | F02, F07, R6-R7                        |
| [v1-ticket11](feats/v1/v1-ticket11.md)                                                  | Required and advisory verification tools      | v1-ticket2                                                               | F12, AC28, AC35-AC36                   |
| [v1-ticket12](feats/v1/v1-ticket12.md)                                                  | Permission-bound native hooks                 | v1-ticket11                                                              | F12, AC27, AC29                        |
| [scheduled-gates-ticket1](feats/scheduled-gates/scheduled-gates-ticket1.md)             | Landed versus fully checked revisions         | v1-ticket11                                                              | F15, R7, AC35-AC36                     |
| [post-landing-review-ticket1](feats/post-landing-review/post-landing-review-ticket1.md) | One conditional review stage                  | scheduled-gates-ticket1                                                  | F16, R7, AC4, AC11                     |
| [v1-ticket5](feats/v1/v1-ticket5.md)                                                    | Relevant phase lessons                        | v1-ticket4                                                               | F04, AC5, AC18                         |
| [v1-ticket6](feats/v1/v1-ticket6.md)                                                    | Snapshot evidence and phase checkpoints       | backup-adoption-ticket1, v1-ticket5                                      | F05, R13, AC22-AC25                    |
| [v1-ticket7](feats/v1/v1-ticket7.md)                                                    | Validated replacement restore                 | v1-ticket6                                                               | F06, AC19, AC21                        |
| [v1-ticket8](feats/v1/v1-ticket8.md)                                                    | Exclusive orchestrator ownership              | v1-ticket7                                                               | F06, AC23                              |
| [v1-ticket9](feats/v1/v1-ticket9.md)                                                    | Exact cross-orb candidate transfer            | v1-ticket4, v1-ticket8                                                   | F03, R5, AC2, AC19                     |
| [v1-ticket10](feats/v1/v1-ticket10.md)                                                  | Supported executor reconnection               | v1-ticket2                                                               | F03, R8, AC8-AC9                       |
| [native-discovery-ticket1](feats/native-discovery/native-discovery-ticket1.md)          | Bounded evidence-backed intake                | v1-ticket5, v1-ticket12                                                  | F17, R2-R4, AC1-AC12                   |
| [remote-monitoring-ticket1](feats/remote-monitoring/remote-monitoring-ticket1.md)       | Durable coordinator CI ownership              | scheduled-gates-ticket1, v1-ticket12                                     | F18, AC37-AC40                         |
| [v1-ticket17](feats/v1/v1-ticket17.md)                                                  | Preservation-gated worker retirement          | v1-ticket5, v1-ticket6, v1-ticket8, v1-ticket9                           | F11, AC24                              |
| [v1-ticket15](feats/v1/v1-ticket15.md)                                                  | Ordered steering backend                      | v1-ticket2, v1-ticket4                                                   | F10, R14                               |
| [v1-ticket18](feats/v1/v1-ticket18.md)                                                  | Delivery and reliability measures             | scheduled-gates-ticket1, remote-monitoring-ticket1, v1-ticket4           | F13, AC30-AC31, AC34                   |
| [v1-ticket19](feats/v1/v1-ticket19.md)                                                  | Versioned evidence scorecards                 | v1-ticket11, v1-ticket18                                                 | F13, AC32                              |
| [v1-ticket20](feats/v1/v1-ticket20.md)                                                  | Authorized usage observations                 | v1-ticket2, v1-ticket18                                                  | F13, AC33                              |
| [v1-ticket3](feats/v1/v1-ticket3.md)                                                    | Repeat-safe repository services               | v1-ticket2                                                               | F01, AC13-AC16, AC20                   |
| [v1-ticket23](feats/v1/v1-ticket23.md)                                                  | Curated lifecycle feed and replay             | v1-ticket1, v1-ticket4, planned-intake-ticket1, foreman-watchdog-ticket2 | F07, R9, AC17                          |
| [v1-ticket13](feats/v1/v1-ticket13.md)                                                  | Workbench evidence and actual lifecycle       | v1-ticket23                                                              | F08, AC17, AC20                        |
| [v1-ticket14](feats/v1/v1-ticket14.md)                                                  | Protected dashboard backup command            | v1-ticket6, v1-ticket13                                                  | F09, AC25                              |
| [v1-ticket16](feats/v1/v1-ticket16.md)                                                  | Steering replies and delivery UI              | v1-ticket13, v1-ticket15                                                 | F10, R14                               |
| [v1-ticket21](feats/v1/v1-ticket21.md)                                                  | Read-only effectiveness views                 | v1-ticket13, v1-ticket19, v1-ticket20                                    | F13, AC30-AC34                         |
| [v1-ticket22](feats/v1/v1-ticket22.md)                                                  | Cross-orb v1 acceptance trial                 | All preceding units                                                      | R1-R16, AC1-AC40                       |

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

Definition [v1-ticket2](feats/v1/v1-ticket2.md) passed native gates and fresh cold review at attempt
four on candidate `901ae38e20fc3517170b43c8b9bea78f6920add1`. It was transferred from the previous
coordinator orb as a checksum-verified Git bundle, merged onto parent main by the Foreman, and
passed the combined gate with 150 tests. foreman-watchdog-ticket1 was then accepted natively at
attempt two and merged through PR #8; see workflow trial 11. foreman-watchdog-ticket2 was accepted
at attempt one and merged through PR #12; see workflow trial 12. foreman-watchdog-ticket3 was
accepted at attempt four and merged through PR #18; see workflow trial 13. Its live proof is still
pending: a scheduled wake of a sleeping orb and real alert delivery. The plugin tool bridge
installed and cleared a real schedule; see workflow trial 14. F001-backup-commit-identity was
accepted at attempt one, merged through PR #20, and proven live. Safe planned intake is next.
Fixing worker executor loss (v1-ticket10) should follow it closely; see trial 13. Keep preserved
backup owners until required evidence preservation is confirmed. Native acceptance does not
authorize retirement.

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
