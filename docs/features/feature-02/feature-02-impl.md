# Feature 02: pass explicit worker reasoning effort to Amp

## Status

- State: locally verified; live factory acceptance recovered by Feature 03. Priority: P0.
- Story: [feature-02-story.md](feature-02-story.md), feature 1.
- Worker: one `openai/gpt-6.1-sol` child at medium effort. No nested delegation.
- Planned locally on 2026-11-13. No external ticket, push, or deployment is authorized.

## Why this matters

The operator requested Sol 6.1/medium for implementation. Model selection already reaches Amp,
but effort is absent from the install configuration, `NativeHost.create`, and plugin adapter.

## Current state

`factory/setup-factory.ts` defaults workerModel to Sol 6.1. `configuration()` in `factory/native.ts`
validates it, and `host.create(owner, workerModel)` dispatches it. `factory/plugin.ts` calls
`amp.createAgent({ model, ... })` without `reasoningEffort`.

The installed plugin API declaration exposes `AgentReasoningEffort` and
`CreateAgentConfig.reasoningEffort`. The supported values are none, minimal, low, medium, high,
xhigh, and max. Use that contract rather than a provider-specific model payload.

## Approach

Add optional `workerEffort` to parsed configuration. Use the native effort type and validate input
at the configuration and CLI boundaries. Fresh installs default to medium. Missing persisted effort
means no override, preserving existing installations. Pass the value through the existing host
operation and adapter. Do not add a new settings service, model registry, or migration layer.

## Scope

- In: `factory/native.ts`, `factory/native.test.ts`, `factory/plugin.ts`,
  `factory/setup-factory.ts`, `factory/setup-factory.test.ts`, and `factory/README.md`.
- Out: persistence rewrite, dashboard code, new dependencies, and edits to this ticket's criteria.

## Steps

1. Extend existing checks to fail on the missing effort behavior before changing implementation.
2. Add CLI parsing and persisted validation, then pass effort through the existing dispatch call.
3. Document defaults, legacy behavior, and settings applying only to new workers.
4. Run focused and existing tests. Return a revision-bound candidate through the factory.

## Test plan

- Exercise real installer subprocesses. Default Sol/medium and explicit `high` must differ.
- Invalid CLI input must leave an uninitialized repo without generated config, plugin, or tickets.
- Invalid saved effort, including null and numeric values, must prevent host creation.
- Missing saved effort must remain undefined, with the config bytes unchanged.
- Capture remote creation settings at the NativeHost boundary. Exercise the configured nondefault
  and missing-effort cases, and retain the existing same-worker correction regression.
- Preserve the existing two-repo refresh checks. Use syntax-invalid input for actual build failure,
  not merely a missing file, if extending that negative control.
- Run `bun test factory/native.test.ts factory/setup-factory.test.ts`, then `bun test`.
- Run strict TypeScript against the installed Amp API declaration and `git diff --check`.

## Done when

All seven story criteria pass. The parent inspects the candidate diff, verifies the real native
agent definition, and reruns checks here before declaring local acceptance.

## Throughput checkpoint

- Blocking first steps: preserve exact current source in a committed disposable snapshot.
- Independent workstreams: none. One ticket and one implementation child at a time.
- Shared mutable state: the worker owns its isolated worktree. The parent owns this checkout.
- Smallest safe decomposition: one owner follows this setting across its existing three boundaries.

## Notes

Read poteto-mode, then perform the relevant work directly. The operator forbids extra seats,
panels, and nested threads. Keep output concise and save full test logs locally.

The parent will bootstrap this worker using a disposable adapter that explicitly sets medium
effort and records Amp's resolved agent definition. That probe is not part of the product patch.

## Drift log

2026-11-13. One Sol 6.1 child implemented the six allowed files. The bootstrap recorded the real
Amp definition as `model: "openai/gpt-6.1-sol"`, `reasoningEffort: "medium"`. There was no second
implementation child or review panel.

The worker's focused checks failed before implementation, then passed after the change. Parent
review applied the candidate patch here and reran `bun test`: 45 pass, 0 fail, 294 assertions.
Strict TypeScript against the installed SDK, targeted formatting, and whitespace checks passed.

The parent's native probe ran the real product adapter through `amp.createAgent` and inspected
Amp's definition. Medium resolved to medium, high to high, and omitted effort stayed omitted.
Only thread execution and observations were substituted. No extra worker was spawned.
Probe sources and full logs are under `.amp/in/scratchpad/factory-feature-02/`.

The kept refresh test now uses an existing syntax-invalid store, addressing the prior trial's
failure-boundary lesson. Legacy configuration and nonempty queues remain unchanged on refresh.

Following an executor interruption, native reconciliation failed with
`thread.state is only available for connected threads`. The supported thread-status tool reports
the original worker idle, and its revision-bound report is preserved. The factory still records
its run as running and has not integrated the candidate. The parent paused dispatch without
rewriting that state, granting acceptance from prose, or starting a replacement.

Local feature verification is complete; automatic post-disconnect acceptance is not. Repair that
recovery path before claiming the next unattended workflow loop. No application commit or push
was made here. The original worker and its worktree remain intact.

Feature 03 subsequently repaired explicit reconciliation. The refreshed adapter verified and
integrated this original candidate with its original worker. Parent checks confirmed one creation,
delivery, acceptance, and revision-ledger entry after repeated reconciliation. No replacement
worker was required. The earlier failed trial remains part of the workflow record.
