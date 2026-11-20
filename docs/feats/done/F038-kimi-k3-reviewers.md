# F038: Kimi K3 reviewers for OpenAI workers

## Status

| Field | Value |
| --- | --- |
| Status | Done |
| Owner | Ethan |
| Effort | Small |
| Risk | Cold-review semantics change; blast radius is every future review and the
  fallback-policy validation matrix. |
| Depends on | None |
| Blocks | Manual low-risk ticket threads on `moonshotai/kimi-k3` low |
| Updated | 2026-11-19 |

- Outcome: Reviewers run on Kimi K3 for OpenAI workers

## Why this matters

The operator's Claude subscription is paused, so no `anthropic/*` model can run. Every cold
review for an OpenAI worker currently defaults to `anthropic/claude-fable-5-2`, so review
creation fails and runs park. The operator's standing model mapping replaces Opus with
`moonshotai/kimi-k3` at high effort, which is exactly the reviewer's role (F020 quality
brief). Until the default mapping supports a third model family, the definition cannot host
`moonshotai/kimi-k3` workers at all: definition reload refuses them because no reviewer
mapping exists for the family.

## Current state

`factory/persistence.ts` `defaultReviewerModels` has one rule: OpenAI workers get
`anthropic/claude-fable-5-2` reviewers and Anthropic workers get `openai/gpt-6-astra`
reviewers. `reviewerModel()` throws "Review requires an OpenAI or Anthropic implementation
worker" for any other family, and `reviewerModel()` runs at `createReviewer` time with
effort high, so the OpenAI-worker reviewer always rides a paused subscription. The reload
refusal for a Moonshot AI worker was observed live: "Review requires an OpenAI or Anthropic
implementation worker".

## Approach

Change the defaults only, no new mechanism:

1. OpenAI workers get `moonshotai/kimi-k3` reviewers (effort stays high, per
   `createReviewer`).
2. Anthropic workers keep `openai/gpt-6-astra` reviewers.
3. Moonshot AI workers get `openai/gpt-6-astra` reviewers, which makes the family usable in
   definitions for manual low-risk ticket threads.
4. Update the refusal message to name the three supported families.
5. Update tests whose expectations come from the old mapping, deriving each new expectation
   from the validation rules, not from the code: a fallback `providerLimit.reviewerModel`
   must be a known family opposite the worker's and must differ from the default reviewer
   for the worker's family; hosted namespaces stay refused.
6. Update README reviewer-model documentation to match.

## Scope

In: `factory/persistence.ts` defaults and message; the audit brief's model, which rides the
same Opus-class mapping; the tests and README passages that encode the old mapping. Out:
dispatch priority, reviewer effort, limit-fallback behavior, definition format.

## Steps

1. **Extend reviewer map** — change `defaultReviewerModels` so OpenAI workers map to
   `moonshotai/kimi-k3`, Anthropic workers stay on `openai/gpt-6-astra`, and Moonshot AI
   workers map to `openai/gpt-6-astra`.
2. **Update refusal message** — the `reviewerModel()` throw names OpenAI, Anthropic, and
   Moonshot AI as the supported implementation-worker families.
3. **Realign tests** — every expectation that names the old default reviewer for an OpenAI
   worker flips to `moonshotai/kimi-k3`; the fallback validation matrix gains Moonshot AI
   worker rows and flips rows whose validity changed because the default moved; the
   setup-factory message regex matches the new wording.
4. **Document mapping** — README states the reviewer defaults for all three families and
   the updated refusal wording.
5. **Gates and review** — run the full local gate, then a cold review of the diff before
   landing.

## Why this approach?

Option B from the thread: change the default mapping rather than special-casing a paused
provider. A new "reviewer override" config knob would be speculative; the defaults are the
one place every review path already reads, and the operator's standing mapping is the
spec. Keeping Anthropic workers on OpenAI reviewers and adding Moonshot AI to OpenAI
reviewers preserves the opposite-family rule the brief requires.

## Files You'll Touch

- `factory/persistence.ts` — `defaultReviewerModels`, `reviewerModel()` message
- `factory/audit.ts` — audit brief model around line 672
- `factory/lanes.test.ts` — reviewer model expectation around line 601
- `factory/native.test.ts` — fallback validation matrix around lines 1685-1790
- `factory/audit.test.ts` — brief assertion around line 311
- `factory/review.test.ts` — reviewer model fixtures around lines 218-361
- `factory/plugin.test.ts` — review record fixtures around lines 1684, 2122, 2132
- `factory/setup-factory.test.ts` — refusal message regex around line 245
- `factory/README.md` — reviewer model section and the provider-limit fallback wording

## Initial state / preflight

- Planning SHA: `69aa994138d8184909c1a9e1509986d46d76964f` (`main` after the F026 merge).
- Definition reload currently refuses a `moonshotai/kimi-k3` implementer with "Review
  requires an OpenAI or Anthropic implementation worker" (observed 2026-11-19).
- Full local gate passed on branch head `9a99606` before the F026 landing close-out; treat
  the gate as green at the planning SHA and revalidate in step 5.

## Done when

- [x] OpenAI workers get `moonshotai/kimi-k3` reviewers by default; Moonshot AI workers get
      `openai/gpt-6-astra`; Anthropic workers stay on `openai/gpt-6-astra`
- [x] The refusal message names all three supported families
- [x] Test expectations follow the validation rules above, including new Moonshot AI rows
- [x] README documents the three-family mapping
- [x] Full local gate passes: `bun run fallow:ci`, `bun run lint:ci`, `bun run typecheck`,
      `bun run format:check`, `bash factory/checks.sh guard`, `bun run web:build`,
      `bun run test`
- [x] Cold review of the diff reports no blocking findings
