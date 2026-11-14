# remote-monitoring-ticket1

## Status

- Goal: retain coordinator-owned CI and review coverage for every authorized published revision.
- Initial priority: P0 when publication is enabled
- Effort: Large
- Risk: elevated; a successful push without monitoring must not appear fully verified.
- Depends on: F12 capabilities, F15 scheduled gates, and serialized native integration.
- Planned at: `e0ceef3f29e5884c0700be855edb9f28084966a4`, 2026-11-13.
- Local path: `docs/feats/remote-monitoring/remote-monitoring-ticket1.md`
- Backlog: F18. Local-only ticket; real publication remains unauthorized.

## Why this matters

A disconnected worker cannot own delivery monitoring. Losing subscription registration after a
successful push must leave a recoverable monitoring gap, not trigger another push or worker.

## Current state

`factory/native.ts` currently requires publishing and external tickets to stay disabled.
`factory/plugin.ts` observes native thread activity, not remote CI or PR reviews. Coordinator
instructions currently register follow-ups manually; durable product monitoring is absent.
PRD R7 and AC37-AC40 define the missing contract.

## Approach

Record authorized delivery and its original implementation owner before requesting native event
coverage. Persist subscription identity separately from delivery success. Reconcile remote truth
after ambiguous registration and events, then return actionable failures to the same worker.

## Scope

- In: durable delivery and monitoring records, supported subscription adapter, recovery, and tests.
- In: exact-revision repair routing and public status that distinguishes unavailable monitoring.
- Out: worker-side hooks, polling agents, new hosting, remote provisioning, or permission changes.
- Allowed edits: `factory/` and the definition schema paths accepted by F12.
- Implement and test with disposable remotes; no real push, PR creation, or subscription is granted.

## Steps

1. **Bind supported delivery identities**. Discover capabilities and correlate ticket, owner, and checks.
2. **Persist independent monitoring outcomes**. Reconcile CI and PR coverage separately from publication.
3. **Reconcile current remote truth**. Deduplicate missed and out-of-order events against actual state.
4. **Repair with original owner**. Route actionable findings and rerun gates on the new revision.

## Test plan

- Use real disposable Git remotes with a controlled external subscription and check boundary.
- Push successfully, fail registration, restart, and recover without duplicate publication.
- Deliver terminal CI before registration recovery; do not resubscribe endlessly.
- Cover CI and PR comments separately; direct commits must not require creating a PR.
- Disconnect the worker and remove its hooks; coordinator coverage remains intact.
- Duplicate and reorder events and check attempts; stale success cannot approve a newer repair.
- Keep repository CI credential-free and retain the unchanged local-only execution path.
- Run full gates and required cold review on the exact integration candidate.

## Why this approach?

Delivery and monitoring fail independently. Separate durable outcomes preserve the published commit
while making the monitoring gap visible; reconciliation avoids repeating an uncertain side effect.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/persistence.ts` | Durable boundary | Transition records | Edit |
| `factory/native.ts` | Coordinator | Acceptance and original-owner repair | Edit |
| `factory/plugin.ts` | Native adapter | Supported event and tool boundary | Edit |
| `factory/dashboard.ts` | Read-only status | Curated durable projection | Edit |
| `factory/persistence.test.ts` | Storage proof | Restart and atomic records | Edit |
| `factory/native.test.ts` | Lifecycle proof | Revision and repair ownership | Edit |
| `factory/plugin.test.ts` | Adapter proof | Subscription recovery and events | Edit |
| `factory/dashboard.test.ts` | Disclosure proof | Missing and stale monitoring | Edit |
| `factory/README.md` | Operator contract | Permissions and monitoring gaps | Edit |
| `.github/workflows/` | CI boundary | Credential-free repository checks | Read |

Build delivery identity and durable outcomes first, then adapter reconciliation and repair routing.
Re-scope exact definition paths after F12.
Reuse supported subscriptions rather than another watcher.

## Initial state / preflight

Implementation checks have not run for this ticket. Publication remains disabled. Before dispatch,
inspect supported subscription parameters and recovery reads through the accepted F12 capability.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record dispatch SHA and explain prerequisite drift. |
| `git status --short` | Preserve and account for existing edits. |
| `git diff --stat e0ceef3..HEAD -- factory/ .github/` | Revalidate prerequisite changes. |
| `git diff -- factory/ .github/` | No unexplained unstaged implementation edits. |
| `git diff --cached -- factory/ .github/` | No unexplained staged implementation edits. |
| `bun --version` | Record toolchain version. |
| `bun install --frozen-lockfile` | Prepare the exact worktree. |
| `bash factory/checks.sh full` | Baseline full gates pass; otherwise return the blocker. |
| `git diff --check` | No whitespace errors. |

## Done when

- [ ] AC37-AC40 refusal and recovery paths pass without worker-owned monitoring.
- [ ] Published work remains distinguishable from fully verified work across restart.
- [ ] Repairs retain the owner and require fresh exact-revision coverage and full gates.
- [ ] No local-only permission changes or duplicate external side effects occur.
- [ ] Full gates and cold review pass; live remote proof is reported separately if unauthorized.
