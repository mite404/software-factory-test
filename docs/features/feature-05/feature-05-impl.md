# Feature 05: private SQLite backup command and tool

## Status

- State: preserved implementation awaiting current canonical adoption. Priority: P0. Backlog: F05.
- Story: [feature-05-story.md](feature-05-story.md).
- Worker: one Sol 6.1 child at medium effort, with no nested delegation.

## Canonical adoption scope

Re-scoped at `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13. Local only.
Effort: Medium. Risk: elevated; backup privacy, uncertain push outcomes, and permission boundaries.
Prerequisites: accepted native preparation, escalation, launcher, and full-gate/review contracts.

The original fixture at `.amp/in/scratchpad/factory-feature-05/repo` contains candidate
`fb46845ea6841e62c5ce9a47b4bf9b99d095b146`, locally landed under older gates.
Original worker `T-01a1d34c-57cf-73e3-a070-206ca5947bc4` and its evidence remain preserved.
That result is not current parent acceptance. Do not reset its state or resume its completed run
against a different base. Admit a distinct canonical adoption ticket/run in the current native
queue. Its owner adapts the exact preserved patch to accepted source, then receives fresh gates,
independent cold review, and same-owner repairs for this adoption unit.

The historical Current state below describes the original base. Inspect the actual accepted
source before implementation; preserve all newer setup, launcher, review, and escalation behavior.

## Steps

1. **Inspect preserved backup candidate**. Compare its patch and old evidence with the current base.
2. **Adopt shared snapshot operation**. Preserve current native safety and separate backup permission.
3. **Verify publication uncertainty controls**. Run local-remotes refusal, no-op, and recovery checks.

## Why this approach?

Reusing the preserved patch avoids rebuilding the feature while a new adoption run makes current
revision-bound acceptance explicit. Old fixture success cannot authorize current integration.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/backup.ts`, `factory/backup.test.ts` | Preserved implementation | Shared operation and proof | Create from inspected patch |
| `factory/native.ts`, `factory/plugin.ts` | Consumers | Configuration and native action | Edit |
| `factory/plugin.test.ts`, `factory/setup-factory.test.ts` | Compatibility | Action and install checks | Edit if needed |
| `factory/README.md` | Contract | Coverage limits and permissions | Edit |
| `factory/persistence.ts` | Source | Current SQLite schema | Read |

Build the adopted operation and tests before adapters. Evidence outside SQLite remains excluded;
v1-ticket6 adds complete preservation after the evidence/lesson contracts exist.

## Initial state / preflight

Run the full dispatch preflight in `docs/v1-execution.md`. Baseline checks have not run for adoption.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record new adoption base, not the old fixture base. |
| `git status --short` | Preserve old fixture and require a clean new candidate base. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect accepted prerequisite drift. |

Canonical completion requires the exact clean candidate to pass every current gate, fresh cold
review, native acceptance, and parent integration. No actual remote push is authorized.

## Current state and goal

`factory/persistence.ts` owns schema-versioned SQLite under the Git directory. State and events
commit atomically. Candidate reports, the poteto ledger, and dashboard observations remain separate.
`factory/plugin.ts` exposes status, start, pause, and reconcile through its registered control tool.
There is no backup command or configured private state repository.

Implement one exported backup operation, a CLI entry, and a backup action in the existing native
tool. Do not duplicate backup logic in adapters. Use Bun SQLite and installed Git/GitHub CLI tools,
not a new hosted service, ORM, or provider-specific agent hook.

## Configuration and security

Use optional `.factory.json` configuration `backup: { repository: "owner/name", projectKey: "key" }`
and explicit `permissions.backup: true`. Missing permission stays false. Keep existing installs,
checks, refresh, worker effort, and queue permissions unchanged. Validate repository identifiers
and project keys at the boundary; reject traversal and arbitrary destinations. The CLI accepts
only the local project root, not shell commands or destination overrides.

Use authenticated GitHub metadata to require a private repository and determine its branch.
Credentials stay in the existing authentication mechanism, never in config, logs, snapshots,
manifests, or tool results. Do not print credential-bearing subprocess output. All subprocesses
that can take time must be asynchronous so the native plugin heartbeat remains responsive.

## Snapshot and publication

Use a supported SQLite consistent snapshot operation and check the output database integrity.
Read project schema version and Git revision into a small manifest. Store only snapshot and
manifest in a stable per-project path in the state repository. Private candidate evidence and
lessons outside SQLite are not covered by this slice; document that limitation for restore.

Preserve existing remote projects and unrelated files. Serialize concurrent backup requests.
No-op unchanged snapshots, including manifest fields. Keep backup receipts outside the snapshot
if recording success inside it would make every backup change its own input. Preserve the last
confirmed result when a later attempt fails. Reject Git conflicts rather than overwriting them.

After push, confirm the intended commit reached the remote branch before returning confirmed.
On ambiguous publication, inspect remote state rather than blindly repeating the push. Keep
pending or uncertain state visible if confirmation itself is unavailable. Never force-push.

## Scope

- In: `factory/backup.ts`, `factory/backup.test.ts`, `factory/plugin.ts`, `factory/plugin.test.ts`,
  `factory/README.md`, and `factory/native.ts` or `factory/setup-factory.ts` only if shared
  configuration parsing needs adjustment.
- Out: frontend, restore, production credentials, provisioning, actual external pushes, worker
  retirement, arbitrary file backup, and persistence-schema rewrites unrelated to backup.

## Verification

- Prove the CLI and registered tool invoke the same real operation. Default or denied backup
  performs no publish. Existing control actions and full tests still pass.
- Use real temporary SQLite and bare Git repos for end-to-end snapshot, commit, push, fetch,
  confirmation, repeat no-op, and isolation of two project keys. Substitute only external GitHub
  authentication/metadata or transport routing; add no production test bypass.
- Reject public/inaccessible repos, invalid keys, absent DB, corrupt DB, concurrent requests,
  rejected pushes, and unavailable confirmation without leaking secrets or losing prior receipts.
- Write coordinator state while snapshotting and verify the snapshot is internally consistent.
- Exercise successful push with a lost response and prove retry confirms without duplicating it.
- Run full `bun test`, strict SDK TypeScript, and whitespace checks. Save complete logs locally.

## Done when and throughput checkpoint

The story's success and refusal paths pass, parent review verifies the local operation, and the
worker returns a revision-bound candidate. Exactly one worker owns one isolated worktree. Parent
owns ticket updates, final verification, and local commits. No external side effect is authorized
by this ticket or by passing its tests.
