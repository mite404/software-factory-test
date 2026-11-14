# F006-limit-fallback-setting

## Status

- Goal: one definition setting that chooses between waiting out a provider limit and continuing
  on a named fallback model.
- Initial priority: P2. Effort: Small.
- Risk: elevated; a fallback changes which model reviews or writes accepted code.
- Depends on: F003-provider-limit-resume.
- Planned at: `af884ca62b0586646e30743a2fc2258ac68346e6`, 2026-11-14. Local only.

## Why this matters

The operator wants to flip a switch between two behaviors when a subscription limit hits: wait for
the reset, or keep the factory moving on another provider. Today neither is a factory setting, and
the reviewer is pinned to one model family.

## Current state

- The project definition has `workerModel`, `workerEffort`, `workerRunner` and `review`. It has no
  limit policy.
- `factory/native.ts` `reviewerModel` picks the reviewer from the family opposite the worker's
  model. With a Sol worker the reviewer is `anthropic/claude-fable-5-2`.
- A run pins its definition, including the worker model, for repairs.
- F003 adds the `provider-limit` incident and the wait path this ticket builds on.
- Whether an existing thread can continue on a different model has not been inspected.
- v1-ticket10 excludes silently changing providers. This ticket makes the change explicit, opt-in
  and recorded.

## Approach

Add an optional `providerLimit` setting with two values. `wait`, the default, is F003's behavior.
`fallback` names a fallback reviewer model, and optionally a fallback worker model. When a
provider-limit incident opens under `fallback`:

- For a reviewer, create a fresh cold reviewer on the fallback model for the same pinned revision.
  Reviewers are already fresh threads, so no knowledge is lost. Record that the review ran on the
  fallback and why.
- For a worker, continue the same thread on the fallback model only if the platform supports it.
  If it does not, the worker waits as in F003; the factory never replaces a worker.

A fallback reviewer from the same family as the worker is refused at definition validation.

## Scope

- In: the setting and its validation, reviewer fallback, worker fallback where supported, the
  record of which model ran, tests and README.
- Out: changing the Foreman thread's own model; that is an Amp setting outside the factory.
- Out: replacing a worker, automatic provider selection, and cost-based routing.
- Preserve: definitions without the setting behave as F003 leaves them.

## Steps

1. **Add the limit policy**. Accept the optional setting with its fallback models, reject invalid
   values and a same-family reviewer fallback before dispatch, and keep existing definitions valid.
2. **Fall back the reviewer**. On a reviewer provider limit under `fallback`, create one fresh
   reviewer on the fallback model for the same revision and record the substitution.
3. **Fall back the worker**. Continue the same worker thread on the fallback model when the
   platform supports it, and otherwise leave it on the wait path.
4. **Document the switch**. Describe both values, what each changes and what it never does.

## Test plan

Use the existing fixture hosts. Cover: `wait` and an absent setting behave identically; an invalid
value and a same-family reviewer fallback fail before any thread is created; a reviewer limit under
`fallback` creates exactly one new reviewer on the fallback model for the same revision and a
second reconcile creates none; the review record names the fallback; a worker limit never creates
a second worker; a pinned run keeps the policy it started with.

## Why this approach?

- Without it: a limit on one provider stops review for hours even when another provider is
  available, or the Foreman swaps models by hand with no record.
- This buys: an explicit, recorded choice. Cold review stays independent because the fallback can
  never share the worker's family, and worker knowledge is never discarded.

## Files You'll Touch

| Path                                          | Role       | Contains                            | Edit or Read |
| --------------------------------------------- | ---------- | ----------------------------------- | ------------ |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle  | Definition parsing, `reviewerModel` | Edit         |
| `factory/definition.schema.json`              | Definition | Accepted settings                   | Edit         |
| `factory/persistence.ts`                      | Records    | Pinned policy, model on review      | Edit         |
| `factory/review.test.ts`                      | Tests      | Reviewer creation and verdicts      | Edit         |
| `factory/README.md`                           | Operations | Model settings                      | Edit         |
| `node_modules/@ampcode/plugin/index.d.ts`     | API        | Whether a thread's model can change | Read         |

Build order: setting, reviewer fallback, worker fallback, README.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                       |
| ------------------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.      |
| `git diff --stat af884ca..HEAD -- factory/`             | Revalidate drift, including accepted F003.     |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                    |
| `rg -n "provider-limit" factory/`                       | Present; F003 must be accepted first.          |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity |

## Done when

- [ ] One setting selects wait or fallback, and its absence means wait.
- [ ] Under fallback a limited reviewer is replaced by one fresh reviewer from another family.
- [ ] No setting ever creates a second worker for a ticket.
- [ ] Records show which model reviewed or wrote each attempt.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
