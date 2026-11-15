# Feature 05: back up private coordinator state

As an operator, I can run one command to save a consistent project snapshot in a private GitHub
repository, so my application can remain public without publishing its factory memory.

## Acceptance criteria

1. One backend operation is callable from a CLI and the native factory control tool. The browser
   button remains later work. Backup permission is separate from execution and application push.
2. Read the destination repository and stable project key from trusted operator configuration.
   Missing configuration or permission fails without remote writes. Keep credentials server-side.
3. Verify the destination is private through authenticated GitHub metadata before publishing.
   Public, inaccessible, malformed, or uncertain metadata fails closed. Do not provision a repo.
4. Produce a transactionally consistent, integrity-checked SQLite snapshot with project identity,
   schema version, and application revision metadata. Never copy a live database file blindly.
5. Several projects can share one private repository in separate project paths. Publish only the
   allowlisted snapshot and manifest, not credentials, transcripts, arbitrary files, or Git
   metadata.
6. Serialize backups, skip unchanged snapshots, and never force-push. Confirm the remote commit
   before reporting success. Reconcile an uncertain push before retrying; preserve conflicting work.
7. Record pending, confirmed, failed, or uncertain backup state and the last confirmed remote
   revision. Later coordinator changes must not be represented as already backed up.

## Boundary

Implement the operation and its tool entry, not a real production push. Tests use disposable local
Git repositories and substitute the external GitHub/authentication boundary. No private repository
creation, actual external push, frontend work, restore, or worker retirement is authorized here.
