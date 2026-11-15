# Feature 06: conditional cold post-graft judge

## Goal and settled design

Implement `feature-06-story.md` through the native factory. One Sol 6.1 implementation worker at
medium effort owns this feature. The user selected one conditional post-graft model review, not
before-and-after reviews. Flag risk at scoping; a retry triggers review automatically.
Small, low-risk first-attempt work uses quality gates only. No scoring service or classifier.

## Existing ownership and reuse

- `factory/native.ts`: candidate checks, asynchronous configured verification, original-worker
  correction, sequential dispatch, and serialized local integration.
- `factory/persistence.ts`: validated runs and atomic state/events in SQLite; keep it authoritative.
- `factory/plugin.ts`: native local agent creation, delivery, observation, and restart attachment.
- `factory/setup-factory.ts`: bundling and preserving saved config.
- Pstack source, read-only: `/home/user/workspace/repo/.amp/in/orb-backup/pstack-source/`.
  Inspect `poteto-mode/playbooks/orchestrate.md` (Verification),
  `poteto-mode/references/pstack-models.md`, and
  `interrogate/references/reviewer-prompt.md` plus `rubric.md`.
  Reuse the cold-review contract, opposite-provider routing, and revision-keyed ledger semantics.
  The existing poteto store is already integrated; do not copy it or create a second framework.

## Required behavior

Add optional `review: true` to trusted config, optional `size: "small" | "medium" | "large"`, and
optional boolean `risky` on ticket definitions. Invalid values fail boundary parsing. With review
enabled, require review unless size is small, risky is false/absent, and this is the first attempt.
Missing size requires review when enabled; existing review-disabled installs retain old behavior.
Mark this feature's live dogfood successor with its actual size and blast-radius assessment.

Borrow create-linear-ticket's separate Effort and Risk fields, not its external filing machinery.
Small means a bounded change with local effects; Medium spans cooperating components; Large changes
cross-cutting behavior or lifecycle. These are scope descriptions, not elapsed-time predictions.
Record a short blast-radius reason in the ticket requirements, covering affected consumers, shared
state or contracts, and the safety fact verification must prove. Elevated risk includes security,
data loss, shared persistence, concurrency/recovery, or integration ownership, even for a tiny diff.
Pstack's `blast-radius/SKILL.md` and `poteto-mode/playbooks/orchestrate.md` (Verification) supply
the evidence standard: exercise the safety fact, do not equate a convincing writeup with proof.
No extra model call or runtime subsystem just to classify risk.

After the full quality gate passes, prepare the exact integration candidate in an isolated staging
branch/worktree. For required review, persist ticket, attempt, revision, integration base,
reviewer ownership and delivery intent before external effects. A fast-forward graft can retain
the worker SHA. Keep the ticket occupied and do not advance the canonical integration checkout or
dependent queue until the post-graft verdict passes. There is only one review stage.

Select the reviewer from the implementation worker's provider, not the coordinator's:
OpenAI to Fable 5.2/high; Anthropic to GPT-6 Astra/high. Reject unsupported providers visibly.
Use a fresh cold native local reviewer for each changed candidate. Reattach on reload; a duplicate
wake-up or unavailable connection must not create another reviewer or repeat delivery.

The reviewer knows it reviews code. Its input is original ticket requirements, actual post-graft
diff/callers, base/revision, and neutral gate evidence. Never supply worker messages, candidate
insight/rationale, self-review, or prior review opinions. Only its structured verdict report may be
written. Require concrete locations and evidence for issues. Empty findings are a valid pass;
avoid speculative style complaints. Use a validated report file like worker reports, not narrative
final text or idle state as approval. Bind its verdict to ticket, attempt, base and revision.

Review issues use the same original-worker correction path and current shared budget: one automatic
correction, then visible blocked state. Repaired candidates rerun full gate and receive a fresh
post-graft verdict. Missing/invalid verdicts spend no correction attempt and create no replacement.
Changed code/base invalidates proof; recheck clean trees and exact identity before landing.
Uncertain creation/delivery stays parked. Preserve all prior evidence and worktrees.

Expose pending review identity/evidence through status and the existing dashboard projection,
without a UI redesign. Preserve no-review behavior and all other permission boundaries.

## Scope

Allowed: native/plugin/persistence and their tests, setup-factory and its test, README, and a small
coherent `factory/review.ts` or `factory/review.test.ts` if needed. Dashboard types/tests may change
only to project review using existing states. No dependencies, gate suppressions, nested workers,
parent checkout writes, queue/config changes, remote writes, unrelated application/UI changes.

## Verification

Start with failing public-behavior evidence: a passing risky candidate cannot land until a cold
post-graft verdict; issues send evidence to its original worker. Use real Git and SQLite,
substituting only native external thread operations. Adapt the earlier two-review prototype rather
than preserving speculative stages or obsolete tests.

Cover opposite-provider/high routing; low-risk first attempts creating no reviewer; a gate retry
triggering review; review rejection/repair and dependent progression; canary worker rationale absent
from prompts; malformed/stale/blocked/missing verdicts; changed base; and reload/duplicate wake-ups
retaining exactly one reviewer per candidate and one acceptance. Test the registered adapter too.

Run `bun test`, `bun run lint:ci`, `bun run typecheck`, `bun run format:check`,
`bun run fallow:ci`, and `git diff --check`, without weakening gates. Save complete red/green and
gate logs under the repository Git factory directory. Report revision, changed paths and evidence.
The parent installs the generated adapter and tests it on live real backlog work; host simulations
alone do not prove the live reviewer lifecycle.
