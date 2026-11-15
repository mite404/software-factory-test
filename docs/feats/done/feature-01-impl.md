# Feature 01: refresh the installed native factory adapter

## Status

- Goal: iterate backend tool code without resetting the installed factory.
- Priority: P0. Category: feature.
- Planned at: local checkout, 2026-11-13. No remote issue has been filed.
- Story: [feature-01-story.md](feature-01-story.md), feature 1.
- State: locally verified. One worker, `openai/gpt-6-luna`, capacity one.

## Why this matters

The factory must build its own backend through bounded tickets. Existing installations cannot pick
up revised plugin code through setup, so each iteration currently needs a separate bundle recipe.

## Current state

`factory/setup-factory.ts` bundles `factory/plugin.ts` with poteto's unchanged `openStore`.
An existing `.factory.json` causes an early return. Missing plugins require manual recovery.
`--check` parses configuration and checks plugin existence without starting workers.

## Approach

Add an explicit refresh branch to the existing installer. Keep the configuration as the source of
truth. Build before replacement and atomically replace only the generated plugin. Reuse the current
bundle operation instead of creating a second installer or copying the bookkeeping implementation.

## Scope

- In: `factory/setup-factory.ts`, `factory/setup-factory.test.ts`, and installer usage in
  `factory/README.md`.
- Out: native dispatcher semantics, plugin behavior, dashboard code, service provisioning, new
  dependencies, remote writes, and changes to this ticket's acceptance criteria.

## Steps

1. Add a real CLI regression check that fails on the original installer for explicit refresh.
2. Implement `--refresh`, including refusal of contradictory flags and uninitialized refresh.
3. Document refresh and explicit reload. Run the targeted checks and existing tests.

## Test plan

- Use disposable Git repos, the real Bun installer and bundler, and a compatible store fixture.
  Never invoke a model or create threads from the test suite.
- In each of two repos, run initial install, ordinary repeat, check, and explicit refresh.
- Seed distinctive config, tickets, and `.git/factory` state. Assert their bytes stay unchanged.
- Prove refresh replaces an obsolete plugin and repairs a missing plugin. Check never repairs it.
- Force a bundle failure and assert that the old plugin remains intact.
  Refuse check plus refresh.
- Run `bun test factory/setup-factory.test.ts`, then `bun test`, and `git diff --check`.

## Done when

The story's seven criteria pass through actual installer subprocesses. The orchestrator reruns the
checks against the returned revision before acceptance. A worker's final text is not acceptance.

## Throughput checkpoint

- Blocking first steps: prepare a committed disposable snapshot containing this uncommitted source.
- Independent workstreams: none. The operator requested one child and one ticket at a time.
- Shared mutable state: the worker edits its factory worktree; the parent retains this checkout.
- Smallest safe decomposition: one installer owner with one CLI test file. No nested delegation.

## Notes

The factory's configured verification controls acceptance and local integration in the disposable
repo. Returning an accepted diff here does not authorize a push, deployment, or worker retirement.
Apply poteto-mode directly. Skip its additional agent seats because the operator forbids fan-out.

## Drift log

2026-11-13. The factory dispatched exactly one native Luna child into a disposable local worktree.
It verified and fast-forwarded the candidate without another dispatch prompt. The parent reviewed
the patch, applied it here, and reran verification. This checkout remains uncommitted and unpushed.

The worker's first CLI test failed before implementation. Its first bundle comparison also failed
because Bun embeds temporary entry paths. The final test checks adapter replacement rather than
byte-identical generated bundles.

The kept test uses a missing store as a validation failure. Parent verification additionally used
an existing syntactically invalid store to prove an actual build failure preserves the plugin.
It checked custom ticket paths, nonempty queues, changed permissions, application files, and all
other file bytes in two disposable repos. No acceptance criterion changed.

Observed checks:

- `bun test`: 43 pass, 0 fail, 226 assertions across 14 files.
- Strict TypeScript and Prettier checks passed for the installer and its test.
- `git diff --check` and the feature Markdown width check passed.
- `bun .amp/in/scratchpad/factory-self-build/verify-refresh.ts`: both repositories passed.

Logs and the repeatable parent probe are under `.amp/in/scratchpad/factory-self-build/`.
The queue is paused. The worker has not been retired. Cross-orb transfer remains untested.
