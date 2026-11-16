# F033-provider-error-shape

## Status

- Goal: a thread stopped by a real provider usage limit is seen as a provider limit, so the
  factory waits or falls back instead of opening a `worker-error` stop.
- Outcome: A real provider limit waits instead of stopping
- Initial priority: P1. Effort: Small.
- Risk: moderate; it changes how every errored worker and reviewer thread is classified.
- Depends on: F006-limit-fallback-setting (done).
- Planned at: `04e1eadc53b8dab47ef141500aaf1e998e350789`, 2026-11-16. Local only.

## Why this matters

On 2026-11-16 the F031 cold reviewer hit Anthropic's 5-hour limit at 09:41 UTC (reset 10:20).
The factory opened stop `0e12108b` with reason `worker-error` and recovery `inspect`. `resume`
refused it because the run was still running, so the Foreman restarted the reviewer by hand. The
F003 wait path and the F006 fallback path have never fired on a real thread.

## Current state

- `reportedActivity` in `factory/plugin.ts` reads the error from `result.agentError`.
- The live `amp.get_thread_status` reply nests it, as recorded on the F031 reviewer:
  `{ metadata: { threadID }, agentState: { state: "error", updatedAt, agentError: { message,
code: "MODEL_PROVIDER_ERROR" } }, preview }`. There is no top-level `agentError`.
- The plugin test fixture near `factory/plugin.test.ts:1830` returns `agentError` at the top
  level, so the tests pass against a shape the tool never sends.
- `wait_for_threads` puts `agentError` beside `state`; that is a different tool and not the
  contract `reportedActivity` reads.

## Approach

- Read the error from `agentState.agentError`, the observed contract. Do not keep a top-level
  fallback that no reply has been seen to use.
- Change every fixture that returns an errored thread status to the observed nested shape.

## Scope

- In: `reportedActivity`, the plugin test fixtures, and a README or `foreman.md` note if either
  describes the reply shape.
- Out: provider-limit timing, reset parsing, wait and fallback policy.
- Preserve: non-provider errors still open a `worker-error` stop.

## Steps

1. **Read the nested error**. Make `reportedActivity` pass `agentState.agentError` to
   `providerActivity`.
2. **Copy the live shape**. Change every errored thread-status fixture to the nested shape
   recorded above, so a fixture with a top-level `agentError` no longer exists.
3. **Prove both thread kinds**. Show a worker and a cold reviewer that error with a rate limit
   both enter the provider-limit path, and a plain error still stops with `worker-error`.

## Test plan

- With the nested shape, a reviewer rate limit under `wait` records a provider-limit incident
  and sends the continuation after reset on the same thread; under `fallback` it creates the
  fallback reviewer.
- The same for a worker thread.
- A nested non-rate-limit `MODEL_PROVIDER_ERROR` and an error with no `agentError` still open
  `worker-error` with recovery `inspect`.
- Run the new tests against the old `reportedActivity` once and confirm they fail.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: every real provider limit stops the factory as an unexplained worker error that
  only a person can clear, which is the outage F003 and F006 were meant to remove.
- This buys: fixtures match the tool's recorded reply, so the tests fail if the shape drifts
  again instead of passing on an invented one.

## Files You'll Touch

| Path                     | Role           | Contains                               | Edit or Read |
| ------------------------ | -------------- | -------------------------------------- | ------------ |
| `factory/plugin.ts`      | Host adapter   | `reportedActivity`, `providerActivity` | Edit         |
| `factory/plugin.test.ts` | Adapter proof  | Thread-status fixtures with errors     | Edit         |
| `factory/native.ts`      | Lifecycle      | `providerWait`, `fallbackReviewer`     | Read         |
| `factory/README.md`      | Operator guide | Provider-limit behavior                | Read or Edit |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                                  | Expected result / action                              |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                                     | Record it; explain differences from the planning SHA. |
| `git status --short`                                     | Clean, or every edit accounted for.                   |
| `rg -n "agentError" factory/plugin.ts factory/*.test.ts` | Revalidate the reader and every fixture.              |
| `bun test factory`                                       | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`                   | No errors.                                            |
| `bun run format:check && bun run fallow:ci`              | Pass.                                                 |
| `bash factory/checks.sh guard`                           | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] A worker or reviewer stopped by a rate limit in the nested reply shape takes the
      provider-limit wait or fallback path.
- [ ] Other errors still stop with `worker-error`.
- [ ] No fixture returns a top-level `agentError`.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
