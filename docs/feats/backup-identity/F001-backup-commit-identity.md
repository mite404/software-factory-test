# F001-backup-commit-identity

## Status

- Goal: make the private backup command succeed where commit signing is tied to one Git identity.
- Initial priority: P0. Effort: Small.
- Risk: elevated; the change touches the only path that moves coordinator state out of the orb.
- Depends on: backup-adoption-ticket1 (accepted).
- Planned at: `3161efc0875f04685306c2bdd30f9e24e22dc590`, 2026-11-14. Local only.

## Why this matters

The coordinator database leaves the orb only through `factory/backup.ts`. On 2026-11-14 the first
real backup, run through the plugin's `backup` action in an Amp orb, failed. The operator ranks
database durability above every other open item, so the supported command has to work unattended.

## Current state

`factory/backup.ts` creates its commit and its rebase with a fixed identity,
`-c user.name=Factory backup -c user.email=factory@localhost`. An Amp orb sets
`commit.gpgsign=true` in `/etc/gitconfig.d/amp-signing` and signs only commits made as the
identity the orb was given. Git's own message for the refused commit was "No signing key is
available for this commit. Amp signs only commits made as the Git identity your current settings
give this orb."

The command swallows subprocess stderr by design, so the operator saw only "Backup failed; inspect
local configuration, database, and repository access", and the receipt said `failed`. The snapshot
and manifest were staged in the retained workspace and nothing was published.

The Foreman worked around it by running `bun factory/backup.ts` with `GIT_AUTHOR_*` and
`GIT_COMMITTER_*` set to the orb identity, which also overrides `-c user.*` for the commit. That run
was confirmed at `mite404/factory-state` revision `7cfef012f4c5c4cfa758f6aba4cc66e91507bb96`, and a
fresh clone matched the live database. The plugin action cannot take that workaround.

`factory/backup.test.ts` configures a `Fixture` identity in its project repository and uses local
bare remotes. No test runs with signing required.

## Approach

Commit and rebase as the identity Git already resolves in the retained backup workspace. Fall back
to the fixed `Factory backup` identity only when Git resolves none, so a machine without a
configured identity keeps working. Do not disable signing, pass `--no-gpg-sign`, or write
configuration into the workspace, the project, or global files.

When the commit step itself fails, raise a known refusal that says the backup commit was refused
and names commit identity and signing as the likely cause. Keep raw subprocess output inside the
boundary, as today.

## Scope

- In: commit and rebase identity in `factory/backup.ts`, its failure message, tests and README.
- Out: restore, scheduled or automatic backup, and the dashboard button; separate tickets own them.
- Out: destination checks, receipts, locking and push behavior; they stay as accepted.
- Out: coordinator configuration and runtime records; setup failures return to the coordinator.

## Steps

1. **Reproduce the refused commit**. Add a fixture whose Git configuration refuses commits made as
   any identity but the configured one, and show the current code fails against it.
2. **Use the ambient identity**. Resolve the workspace's identity for commit and rebase, with the
   fixed identity only as the fallback when none resolves.
3. **Name the commit refusal**. Report a refused backup commit distinctly without leaking
   subprocess output, and document the behavior.

## Test plan

Use disposable local bare remotes only, never GitHub. Cover: a signing-style fixture that accepts
only the configured identity publishes and confirms; a repository with no identity still publishes
through the fallback; the rebase of an unpublished backup commit uses the same identity; a refused
commit yields the named refusal, a `failed` receipt that keeps `lastConfirmed`, and a retry that
succeeds once the cause is fixed. Existing backup tests pass unchanged.

## Why this approach?

- Without it: every backup in an orb fails silently behind a generic message, and the only fix is
  an environment workaround the plugin action cannot use.
- This buys: one identity rule in one place. The platform keeps deciding what it signs, and the
  command never weakens signing to get a commit through.

## Files You'll Touch

| Path                     | Role            | Contains                              | Edit or Read |
| ------------------------ | --------------- | ------------------------------------- | ------------ |
| `factory/backup.ts`      | Backup boundary | Commit, rebase, receipt and refusals  | Edit         |
| `factory/backup.test.ts` | Backup proof    | Local-remote publication cases        | Edit         |
| `factory/README.md`      | Operator docs   | Backup identity, signing and failures | Edit         |
| `factory/plugin.ts`      | Control action  | `backup` action calling the same code | Read         |

Build order: failing fixture, identity resolution, refusal message, README.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                     |
| ------------------------------------------------------- | -------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.    |
| `git diff --stat 3161efc..HEAD -- factory/`             | Revalidate drift in the backup files.        |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                  |
| `rg -n "user\.(name\|email)" factory/backup.ts`         | Two fixed-identity sites: commit and rebase. |

## Done when

- [x] A backup commit is made as the identity Git resolves, with a fallback only when none exists.
- [x] The command never disables signing or writes Git configuration.
- [x] A refused commit is reported distinctly, keeps `lastConfirmed`, and retries cleanly.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
- [x] Live proof by the Foreman after acceptance: the plugin `backup` action returns `confirmed`
      in an orb with no identity variables set.

Accepted at attempt one on `36d79f36718106acacb50935e66e909d4b3f9793` and merged through PR #20.
See workflow trial 14 for the live proof.
