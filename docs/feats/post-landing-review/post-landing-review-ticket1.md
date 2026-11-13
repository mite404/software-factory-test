# post-landing-review-ticket1

## Status

- Goal: support the target post-landing review stage without weakening the existing acceptance gate.
- Initial priority: P0
- Effort: Large
- Risk: elevated; review, repairs, dependent dispatch and verification state must agree.
- Depends on: F15 scheduled gates and F12 effective configuration.
- Planned at: `7a3b1c6c705c0c54bc08b5f7734fd3ffb78de608`, 2026-11-13.
- Local path: `docs/feats/post-landing-review/post-landing-review-ticket1.md`
- Backlog: F16. Local-only draft; implementation not started.

## Why this matters

The target diagram reviews risky or retried changes after landing and full verification. Trial 9
instead proved conditional cold review in isolated staging before canonical acceptance.

## Current state

`factory/review.ts` binds a post-graft verdict to ticket, attempt, candidate and base. `beginReview`
and `settleReview` in `factory/native.ts` withhold acceptance until required review passes.
`reviewerModel` selects the opposite provider at high effort. Preserve those safety facts.

## Approach

Make the review stage explicit under the accepted project policy. Reuse the existing cold-review
contract and original worker. A landing and a full-gate pass are not final review acceptance. Do not
run both pre-landing and post-landing model reviews by default.

## Scope

- In: one conditional post-landing review, durable stage identity, repair routing and curated
  status.
- Out: review scoring, mandatory double reviews, auto-reverts, batching, and remote merge
  permission.
- Expected edit boundary: `factory/`; validate F12 and F15 interfaces before implementation.

## Steps

1. Represent exact landed revision, gate result and required review as distinct durable facts.
2. Run one cold opposite-family review when size, risk or retry policy requires it.
3. Route findings to the original worker; repaired revisions rerun the complete required gate.
4. Preserve review isolation, revision invalidation and truthful dependent-dispatch rules.

## Test plan

- Exercise a real disposable landing, full-gate pass, review rejection, same-owner repair and pass.
- Small low-risk first attempts skip model review, not mandatory gates.
- Medium, large, unrated, risky and retried candidates require the configured one review.
- Advance integration or repair the candidate; old verdicts cannot approve the new artifact.
- Restart after uncertain creation or delivery; do not create duplicate reviewers or repair
  messages.
- Check the reviewer brief excludes author rationale, transcripts and prior reviewer opinions.

## Why this approach?

Reusing the revision-bound review contract avoids a second lifecycle with weaker ownership rules.
Keeping acceptance separate from landing prevents dependents from relying on a rejected change.

## Files You'll Touch

| Path                          | Role              | Contains                                          | Edit or Read |
| ----------------------------- | ----------------- | ------------------------------------------------- | ------------ |
| `factory/review.ts`           | Review contract   | Stage and bound verdict identity                  | Edit         |
| `factory/native.ts`           | Lifecycle         | Post-landing review and original-owner correction | Edit         |
| `factory/persistence.ts`      | Durable boundary  | Landing, gate and review correlation              | Edit         |
| `factory/plugin.ts`           | Projection        | Review state and native observations              | Edit         |
| `factory/review.test.ts`      | Contract proof    | Verdict and cold-brief validation                 | Edit         |
| `factory/native.test.ts`      | Behavioral proof  | Landing, review, repair and restart               | Edit         |
| `factory/persistence.test.ts` | Storage proof     | Bound review recovery                             | Edit         |
| `factory/dashboard.test.ts`   | Projection proof  | Distinct landed and accepted outcomes             | Edit         |
| `factory/README.md`           | Operator contract | Policy and failure behavior                       | Edit         |

Read the accepted scheduled-gate and definition contracts first. Build the durable stage and verdict
identity before lifecycle orchestration, then observation compatibility and documentation.

## Initial state / preflight

Not run for this draft. Re-scope against accepted F12 and F15 artifacts before dispatch.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record dispatch SHA and prerequisite revisions.       |
| `git status --short`                        | Preserve known edits; require a clean candidate base. |
| `git diff --stat 7a3b1c6..HEAD -- factory/` | Inspect changed lifecycle contracts.                  |
| `git diff -- factory/`                      | No unexplained unstaged changes.                      |
| `git diff --cached -- factory/`             | No unexplained staged changes.                        |
| `bun --version`                             | Record tool version.                                  |
| `bun install --frozen-lockfile`             | Dependencies prepared in the exact worktree.          |
| `bash factory/checks.sh full`               | Full baseline gate passes.                            |
| `git diff --check`                          | No whitespace errors.                                 |

## Done when

- [ ] The configured target pipeline has one conditional cold review after landing and full gate.
- [ ] Rejection retains the original worker and never masquerades as final acceptance.
- [ ] Changed revisions rerun full gates and required review; old verdicts grant no permission.
- [ ] Restart cannot duplicate review creation or correction delivery.
- [ ] The exact implementation candidate passes full gates and independent required review.
