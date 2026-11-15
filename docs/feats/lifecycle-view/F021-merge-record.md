# F021-merge-record

## Status

- Goal: the factory records, for each accepted ticket, the pull request and merge commit that
  put it on the remote main branch, and the feed publishes them.
- Initial priority: P1. Effort: Small.
- Risk: elevated; adds an owner-only control action and publishes a URL. A wrong record would
  point a landed ticket at the wrong change, so the factory checks the commit with Git.
- Depends on: nothing. F018-landed-card-links shows the number and link; F014-lifecycle-stages
  reads this record for its `merged` stage instead of adding its own.
- Planned at: `78d0d54c44d41f08b110c7e683c48a9778254f74`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the operator asked for the pull request number on each landed card, so that when
the Foreman says "PR #36 landed" they can find that ticket, reread its steps and open GitHub.
The factory cannot supply it: acceptance is a local fast-forward, and the pull request is opened
and merged by the Foreman afterwards, outside the factory.

## Current state

- `accept` in `factory/native.ts` fast-forwards the factory root to the candidate and records
  `done` with the accepted revision. Nothing about a pull request or the remote is stored.
- The Foreman integrates by cherry-picking the accepted revision onto a branch from `main`, so
  the commit on main has a different hash from the accepted revision but the same change.
- `controlActions` in `factory/plugin.ts` lists the owner-only actions: status, start, pause,
  reconcile, reload, resume, retry-setup, retry-create, admit, backup.
- `projectTask` in `factory/dashboard.ts` publishes `revision` and nothing about a merge.
- F014 plans a merge action with a merge time, pull request number and URL.

## Approach

Add an owner-only control action, `record-merge`, taking a ticket, a pull request number and a
merge commit. It is accepted only when the ticket is `done`, the commit is an ancestor of the
configured target branch as fetched, and the accepted change is in it: the patch of the accepted
revision against its base applies as already present in the merge commit's tree. Store the
number, the commit and the commit's time on the run. Build the URL from the repository's
configured GitHub remote and the number; never store a URL passed by the caller. Recording the
same values twice is a no-op; different values for a recorded ticket are refused.

Publish `merge: { pr, url, commit, at }` or null on each task in the feed. The Foreman calls the
action after each merge; foreman.md says so. For tickets merged before this change the Foreman
records them once by hand from the pull request list.

## Scope

- In: the action, its checks, the stored record, the feed field, tests, README and foreman.md.
- Out: opening or merging pull requests from the factory, calling the GitHub API, the `merged`
  stage (F014), and drawing (F018).
- Preserve: saved state opens unchanged; a ticket with no record publishes `merge: null`.

## Steps

1. **Store the merge record**. Add the optional record to a done run and validate it at the
   storage boundary.
2. **Verify with Git**. Check ancestry on the target branch and that the accepted change is in
   the merge commit.
3. **Add the control action**. Expose owner-only `record-merge`, repeat-safe, refusing a
   conflicting second record.
4. **Publish the record**. Add `merge` to the feed with a URL built from the configured remote.
5. **Document the action**. Describe it in the README and add the call to the Foreman's merge
   step.

## Test plan

With the real Git and SQLite fixtures: a cherry-picked commit on the target branch records; a commit
not on the target branch, a commit on it that lacks the change, a ticket that is not done, and a
caller who is not the owner are each refused; the same record twice is a no-op and a different one
is refused. The feed shows the number, a URL of the form
`https://github.com/<owner>/<repo>/pull/<n>` and the commit; a remote that is not GitHub publishes
the number with a null URL; a planted private canary stays out of the feed. A state file saved
before this change opens.

## Why this approach?

- Without it: only the Foreman's chat says which pull request carried a ticket, and the page
  can show a hash that is not even the hash on main.
- This buys: one checked record per ticket. Verifying with Git means a typo cannot attach the
  wrong pull request, and building the URL from configuration keeps caller text out of a link.

## Files You'll Touch

| Path                                                    | Role       | Contains                    | Edit or Read |
| ------------------------------------------------------- | ---------- | --------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records    | Run kinds and validation    | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle  | `accept`, Git helpers       | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Adapter    | `controlActions`            | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Projection | `projectTask`               | Edit         |
| `factory/README.md`, `factory/foreman.md`               | Operations | Control actions, merge step | Edit         |

Build order: record, Git check, action, feed, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat 78d0d54..HEAD -- factory/`             | Revalidate drift.                               |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                     |
| `rg -n "controlActions" factory/plugin.ts`              | The action list.                                |
| `rg -n "async function accept" factory/native.ts`       | Where acceptance is recorded.                   |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity. |

## Done when

- [ ] `record-merge` stores a pull request number and merge commit only after Git confirms them.
- [ ] The feed publishes the record with a URL built from configuration, or null.
- [ ] A wrong commit, a wrong ticket state and a non-owner caller are refused.
- [ ] Saved state opens unchanged.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
