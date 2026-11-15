# F014-lifecycle-stages

## Status

- Goal: give every run one named stage that says where it is and who must act, including the
  four stages the factory does not record today: gating, reviewing, escalated and merged.
- Initial priority: P1. Effort: Medium.
- Risk: elevated; adds two recorded facts to runs and a control action, and every status reader
  starts using the stage.
- Depends on: F007-run-transition-table and F009-attempt-cap-parking, so the stage list includes
  `parked` and reads the declared table. F012-lifecycle-graph-view draws these stages and should
  follow this ticket.
- Planned at: `0b8a74de02ddff893669726f3759de98e19a4ebf`, 2026-11-15. Local only.

## Why this matters

The operator wants all of these states visible. Today a ticket that is running its gate, one
that is in cold review and one whose worker is still writing are the same `running` run. A
ticket waiting for the Foreman after two rejections is a `blocked` run like any other. A ticket
the factory accepted and a ticket merged to the remote main branch are both `done`. The page and
the Foreman have to infer each difference.

## Current state

- `factory/persistence.ts` declares seven run kinds: `preparing`, `preparation-failed`,
  `creating`, `running`, `blocked`, `uncertain` and `done`.
- **Gating:** `verifyCandidate` in `factory/native.ts` runs the gate inside a reconcile call and
  awaits it. Nothing is saved while it runs, so a status read during a gate shows `running`.
- **Reviewing:** a `running` run with a `review` record. `web/derive.ts` infers the review step
  from that record's presence.
- **Escalated:** a `blocked` run with `repair` set and incident reason `verification-rejected`.
  v1-ticket23 plans a waiting-for-Foreman marker for the same fact.
- **Merged:** `accept` fast-forwards the factory root to the candidate and records `done` with
  event `accepted`. The pull request and merge on the remote are done by the Foreman outside
  the factory and are not recorded anywhere in state.
- `factory/dashboard.ts` reduces all of this to five public statuses.

## Approach

Keep the run kinds. Add one pure function that names a run's stage from the run and its
incident: `queued`, `planned`, `preparing`, `creating`, `building`, `gating`, `reviewing`,
`escalated`, `parked`, `rate-limited`, `blocked`, `uncertain`, `accepted` and `merged`. Each
stage carries who must act, using the actor labels from F011 where they exist: operator,
Foreman, clock or nobody.

Two stages need a recorded fact:

- `gating`: save a gate marker with its start time on the run before the gate starts and remove
  it when the gate returns. A marker found at startup means the gate was interrupted; the run
  is gated again, since a gate has no effect outside its worktree.
- `merged`: add an owner-only control action that records the merge commit for an accepted
  ticket. It is accepted only when Git shows that commit on the configured target branch and
  the commit's tree contains the accepted change. The stage is `merged` after that.

Status, the dashboard feed and the stop notice read the stage from this one function. The
existing five public statuses stay, derived from the stage, until F017 removes them.

The dashboard thread asked for these facts, so the page draws them without inferring:

- The feed declares the stage list in order, with each stage's actor, once per response.
- Each run carries its stage, actor, the time it entered the stage, the index of its pipeline
  step, its attempt, and after a rejection which step rejected it: gate or cold review.
- The stage for a provider-limit wait is named `rate-limited`, not `waiting`, and carries the
  time the limit clears when the factory knows it.
- Acceptance records the landing time and the worker report's one-line summary, cut to a fixed
  length and published only after the same curation as titles.
- The merge record carries the merge time, the pull request number and its URL, each validated.

No `submitted` stage is added: a candidate is read and gated in the same reconcile call, so
nothing can be observed between `building` and `gating`.

## Scope

- In: the stage function, the gate marker, the merge record and its control action, the
  projection, tests, README and foreman.md.
- Out: new run kinds, changing what any stage does, drawing (F012), and opening or merging pull
  requests from the factory.
- Preserve: saved state opens unchanged, and the five public statuses keep their meaning.

## Steps

1. **Name every stage**. Write the pure stage function with its actor per stage and a test case
   for each stage.
2. **Mark a running gate**. Save and clear the gate marker around the gate, and gate again when
   a marker is found after a restart.
3. **Record a remote merge**. Add the owner-only action that stores a verified merge commit on
   an accepted ticket.
4. **Project the stage**. Add the stage and its actor to status and the dashboard feed, and
   derive the five public statuses from it.
5. **Document the stages**. List the stages, who acts on each, and the merge action in the
   README and foreman.md.

## Test plan

With the real Git and SQLite fixtures: a status read taken while a slow gate runs shows
`gating`; a restart during a gate runs the gate again and settles once. A run with a review
record shows `reviewing`. Two rejections show `escalated` and four show `parked`. The merge
action refuses a commit that is not on the target branch, a commit that lacks the accepted
change, and a caller who is not the owner; with a valid commit the stage becomes `merged`. A
table test asserts every run kind and incident reason maps to exactly one stage. A state file
saved before this change opens and maps to a stage.

## Why this approach?

- Without it: each reader works out the stage for itself. The page already does this with a
  step count, the Foreman does it by reading events, and they can disagree.
- This buys: one function owns the answer, so status, the page and notices cannot differ.
  Leaving the run kinds alone keeps every existing transition and saved state valid; only the
  two facts that truly are not recorded get a field.

## Files You'll Touch

| Path                                                    | Role       | Contains                           | Edit or Read |
| ------------------------------------------------------- | ---------- | ---------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records    | Run kinds, validation, F007 table  | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Lifecycle  | `verifyCandidate`, `accept`, stops | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`           | Adapter    | Control actions, status result     | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`     | Projection | Run kind to public status          | Edit         |
| `web/derive.ts`                                         | Page model | Steps inferred from status         | Read         |
| `factory/README.md`, `factory/foreman.md`               | Operations | Stages and the merge action        | Edit         |

Build order: stage function, gate marker, merge record, projection, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                    | Expected result / action                        |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                 | Record the dispatch revision; clean tree.       |
| `git diff --stat 0b8a74d..HEAD -- factory/`                | Revalidate drift, including F007 and F009.      |
| `git diff -- factory/ && git diff --cached -- factory/`    | Preserve unrelated changes.                     |
| `rg -n "async function verifyCandidate" factory/native.ts` | Where the gate runs.                            |
| `rg -n "parked" factory/persistence.ts`                    | Present; F009 accepted first.                   |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`             | Passes; CI runners have no global Git identity. |

## Done when

- [ ] Every run maps to exactly one named stage with one actor, proven by a table test.
- [ ] A gate in progress shows `gating`, and an interrupted gate recovers without a manual step.
- [ ] `reviewing`, `escalated` and `parked` are distinct stages in status and the feed.
- [ ] A verified merge commit moves an accepted ticket to `merged`; an unverified one is refused.
- [ ] Saved state opens unchanged and the five public statuses keep their meaning.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

v1-ticket23 plans a waiting-for-Foreman marker. `escalated` here is that fact; whichever ticket
lands second reuses the first one's field.
