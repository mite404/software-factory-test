# v1-ticket14

## Status

- Goal: invoke the shared backup operation through an authorized dashboard control.
- Initial priority: P1. Effort: Medium. Risk: elevated; browser actions can publish private state.
- Depends on: v1-ticket6 and v1-ticket13.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F09. Local only; pending snapshot and frontend acceptance.

## Why this matters

The Back up now control is a placeholder and cannot yet acknowledge confirmed preservation.

## Current state

The dashboard API accepts only GET. Feature 05 will supply one deterministic shared backup
operation.

## Approach

Add a separately protected POST action using server configuration only. Require authenticated,
authorized requests and cross-origin protection. Reuse CLI/checkpoint serialization and receipts.
Display disabled, pending, failed, uncertain, and last-confirmed outcomes in the existing UI.

## Scope

Include the backup action and its UI. Exclude browser-supplied destination/commands/credentials,
real remote pushes, permission expansion, and weakening the read-only status endpoint.

## Steps

1. **Protect explicit backup requests**. Validate origin, authentication, permission, and bounded
   body.
2. **Reuse shared snapshot operation**. Serialize duplicate clicks with CLI and checkpoint requests.
3. **Render confirmed backup outcomes**. Keep old success visible when newer work is unbacked.

## Test plan

Use real HTTP and local bare remotes. Reject unauthenticated, cross-origin, unauthorized, and
destination-injection requests with no push. Double-click and retry lost responses. Inspect
disabled/pending/failure/success UI, keyboard interaction, and resulting receipt identities.

## Why this approach?

One operation avoids a browser path with weaker snapshot or confirmation rules.

## Files You'll Touch

| Path                                                | Role             | Contains                          | Edit or Read                 |
| --------------------------------------------------- | ---------------- | --------------------------------- | ---------------------------- |
| `factory/dashboard.ts`, `factory/dashboard.test.ts` | HTTP             | Protected command boundary        | Edit                         |
| `factory/backup.ts`, `factory/backup.test.ts`       | Shared operation | Snapshot serialization            | Read after adoption          |
| `web/` after frontend integration                   | Control          | Backup state and interaction      | Edit with owner coordination |
| `factory/README.md`                                 | Security         | Authorization and origin contract | Edit                         |

Establish the authenticated backend boundary before frontend changes.

## Initial state / preflight

Execute `docs/v1-execution.md` preflight. Resolve actual portal authentication semantics first.

| Command                                     | Expected result / action                             |
| ------------------------------------------- | ---------------------------------------------------- |
| `git rev-parse HEAD`                        | Confirm shared backup and combined UI prerequisites. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect API and permissions drift.                   |

## Done when

- [ ] CLI, checkpoints, and UI use one operation with duplicate protection and remote confirmation.
- [ ] Unauthorized requests cannot cause effects; browser evidence and full gates pass.
- [ ] Required cold review passes; actual remote publication remains unauthorized.
