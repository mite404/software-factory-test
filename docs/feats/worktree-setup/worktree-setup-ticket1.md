# worktree-setup-ticket1

## Status

- Goal: prepare each exact worker worktree before creating or messaging its implementation worker.
- Initial priority: P0
- Effort: Medium
- Risk: elevated; setup failure and restart must not duplicate workers or consume repair attempts.
- Depends on: accepted native dispatch, SQLite persistence, and conditional cold review.
- Planned at: `7a3b1c6c705c0c54bc08b5f7734fd3ffb78de608`, 2026-11-13.
- Local path: `docs/feats/worktree-setup/worktree-setup-ticket1.md`
- Backlog: F14. Local-only ticket; implementation not started.

## Why this matters

Feature-07 lacked local dependencies. Fallow ran from an ancestor and falsely reported an unused
dependency. A frozen installation in the unchanged worker checkout made the gate pass.

## Current state

`dispatchNext` in `factory/native.ts` creates a worktree and immediately creates a thread. No
preparation stage exists in `Run`. `checks.sh` installs dependencies only when explicitly called;
the native configured gate does not necessarily call it.

## Approach

Add an optional operator-owned setup command. Run it in the new worktree before native creation.
Persist preparation state and evidence through existing SQLite transitions. Retry preparation only
through an explicit coordinator action, reusing the worktree. Never repeat ambiguous thread
creation.

## Scope

- In: native configuration, dispatch, durable setup recovery, observation compatibility, and tests.
- Out: YAML definition migration, remote execution, automatic dependency guessing, and UI redesign.
- Allowed edits: `factory/` only. Do not edit live configuration, queue, or runtime records.

## Steps

1. Model preparing and failed preparation separately from implementation attempts and creation.
2. Execute bounded setup with durable logs before worker creation; leave no worker on failure.
3. Recover the same worktree explicitly and preserve existing uncertain-creation safeguards.
4. Document the configuration and run the full gate plus required cold review.

## Test plan

- Reproduce dispatch into a fresh worktree with no local dependencies through `createFactory.tick`.
- Assert a declared preparation command creates a local marker before the worker receives work.
- Fail setup, restart, and reconcile; no worker is created and failure evidence remains available.
- Explicitly retry successful setup in the same worktree; create only one worker at attempt one.
- Repeated or concurrent reconcile cannot overlap setup or duplicate thread creation.
- Missing setup preserves existing repositories. A failing or timed-out setup never dispatches.
- Run the actual frozen install and full gates in a fresh dogfood worker checkout.

## Why this approach?

Without a coordinator-owned preparation stage, unrelated code repairs absorb environment failures.
Preparing before creation keeps infrastructure recovery separate from worker ownership and attempts.

## Files You'll Touch

| Path                            | Role                  | Contains                                             | Edit or Read |
| ------------------------------- | --------------------- | ---------------------------------------------------- | ------------ |
| `factory/native.ts`             | Lifecycle             | Configuration, setup, dispatch and explicit recovery | Edit         |
| `factory/persistence.ts`        | Durable state         | Preparation records and validation                   | Edit         |
| `factory/plugin.ts`             | Native adapter        | Recovery action and status projection                | Edit         |
| `factory/setup-factory.ts`      | Installation          | Safe optional setup configuration                    | Edit         |
| `factory/native.test.ts`        | Behavioral proof      | Fresh setup and restart scenarios                    | Edit         |
| `factory/persistence.test.ts`   | Storage proof         | Preparation validation and durable restart           | Edit         |
| `factory/plugin.test.ts`        | Adapter proof         | Recovery and status compatibility                    | Edit         |
| `factory/setup-factory.test.ts` | Installation proof    | Preserved operator settings                          | Edit         |
| `factory/README.md`             | Operator contract     | Setup command, timeout and explicit retry            | Edit         |
| `factory/checks.sh`             | Existing verification | Frozen dependency installation                       | Read         |

Build durable states first, then native transitions, adapter compatibility, tests and documentation.
Reuse existing subprocess and locking boundaries rather than adding another queue or setup service.

## Initial state / preflight

Planning commands have not been run for this ticket. The coordinator prepares this bootstrap
worktree manually once because the missing setup feature cannot prepare its own initial worker.

| Command                                     | Expected result / action                                 |
| ------------------------------------------- | -------------------------------------------------------- |
| `git rev-parse HEAD`                        | Record dispatch SHA and explain planned-SHA differences. |
| `git status --short`                        | Preserve and account for existing edits.                 |
| `git diff --stat 7a3b1c6..HEAD -- factory/` | Inspect accepted prerequisite drift.                     |
| `git diff -- factory/`                      | No unexplained unstaged edits.                           |
| `git diff --cached -- factory/`             | No unexplained staged edits.                             |
| `bun --version`                             | Record installed version.                                |
| `bun install --frozen-lockfile`             | Dependencies installed in this exact worktree.           |
| `bun run test`                              | Baseline passes.                                         |
| `bun run lint:ci`                           | Strict lint passes.                                      |
| `bun run typecheck`                         | Native type checks pass.                                 |
| `bun run format:check`                      | Formatting passes.                                       |
| `bun run fallow:ci`                         | Fallow passes without suppressions.                      |
| `bash factory/checks.sh guard`              | Guard passes.                                            |
| `git diff --check`                          | No whitespace errors.                                    |

## Done when

- [ ] Setup succeeds in the exact worktree before implementation delivery.
- [ ] Failed setup preserves diagnostics and blocks creation without spending an attempt.
- [ ] Explicit retry and restart reuse the worktree and do not duplicate workers.
- [ ] Omitted setup preserves existing configuration behavior.
- [ ] The exact candidate passes full gates and required independent post-graft review.
