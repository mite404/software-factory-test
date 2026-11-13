# Feature 05: private SQLite backup command and tool

## Status

- State: ready for implementation. Priority: P0. Category: feature. Backlog item: F05.
- Story: [feature-05-story.md](feature-05-story.md).
- Worker: one Sol 6.1 child at medium effort, with no nested delegation.

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
