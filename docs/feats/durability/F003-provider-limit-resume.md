# F003-provider-limit-resume

## Status

- Goal: resume the same worker, reviewer and Foreman without operator action once a provider usage
  limit resets.
- Initial priority: P0. Effort: Medium.
- Risk: elevated; an automatic nudge sends a message to a worker without a Foreman decision.
- Depends on: foreman-watchdog-ticket3, F002-worker-runner-executor and the deferred runner
  creation from PR #24 (all merged).
- Planned at: `af884ca62b0586646e30743a2fc2258ac68346e6`, 2026-11-14. Local only.

## Why this matters

On 2026-11-14 the operator's Anthropic subscription hit its five-hour limit at 17:19 UTC with a
reset at 19:00 UTC. The factory did not continue by itself:

- The watchdog wakes at 17:41, 18:11 and 18:41 UTC each failed on the same limit.
- The Foreman resumed at the 19:11 wake, eleven minutes after the reset.
- The F002 reviewer stayed in error until the Foreman sent it a message by hand.

The operator wants the whole factory to continue as soon as the limit lifts.

## Current state

- `factory/plugin.ts` `reportedActivity` reads only `agentState.state` from
  `amp.get_thread_status` and maps it to `error`. It ignores the `agentError` object.
- Observed on 2026-11-14 from a connected thread: `agentError` carried code
  `MODEL_PROVIDER_ERROR` and a message containing
  `{"type":"rate_limit_error","message":"You've hit your 5-hour limit · resets 7pm (UTC)"}`. Amp
  did not retry it. No separate retry time field was observed.
- `factory/native.ts` `activityReasons` turns every `error` into a `worker-error` incident with
  recovery `inspect`, for worker and reviewer alike.
- `factory/watchdog.ts` registers one fixed rule, `RRULE:FREQ=MINUTELY;INTERVAL=30`, and treats any
  other rule as drifted.
- The plugin's `agent.start` handler runs `reconcile` in the owner thread before the model answers.
  Whether it still runs when the model call then fails on the limit has not been observed.
- The installed plugin type has no `agentError`. The detail is known to be available only through
  `ctx.tools.call("amp.get_thread_status")` in a connected owner context.

## Approach

Classify a provider usage limit as its own stop instead of a generic worker error. Record the
limit, the raw provider message and the reset time when it can be parsed. A provider-limit
incident has recovery `wait`: once the reset time has passed, the next connected owner reconcile
sends one continuation message to the same thread and records it. No model call is involved in
that decision. Keep one nudge per incident; if the thread errors again, a new incident starts.

Aim one watchdog wake just after the reset so the Foreman also resumes then, and keep the
30-minute rule afterwards. When the reset time cannot be parsed, nudge on the first reconcile
that observes the thread no longer in error or after one watchdog interval, whichever is first.

## Scope

- In: reading `agentError`, the `provider-limit` reason and `wait` recovery, the stored reset time,
  the single automatic continuation, the reset-aligned wake, tests, README and foreman.md.
- Out: switching models or providers; F006 owns that.
- Out: transferring ownership; F005 owns that.
- Out: parsing assistant prose, replacing a worker or reviewer, and unbounded retries.
- Preserve: every other error stays `worker-error` with recovery `inspect`.

## Steps

1. **Classify the provider limit**. Read `agentError` from the connected status result and
   recognize a provider rate limit by its structured code and error type, never by assistant
   prose; anything unrecognized stays a `worker-error`.
2. **Record limit and reset**. Store a `provider-limit` incident with recovery `wait`, the raw
   provider message and the parsed reset instant, and open databases written before this change
   unchanged.
3. **Nudge the same thread**. After the reset, send one continuation message to the same worker or
   reviewer from the connected owner reconcile, record intent before sending, and never repeat an
   uncertain send.
4. **Aim the next wake**. Register the watchdog so one wake lands just after the recorded reset,
   then return to the 30-minute rule, without clearing unrelated schedules.
5. **Document the wait path**. Describe the incident, what resumes by itself and what still needs
   the Foreman.

## Test plan

Use the existing fixture hosts; hit no real limit. Cover: a status result with the observed
`agentError` shape yields `provider-limit`, not `worker-error`; a different error still yields
`worker-error`; a reconcile before the reset sends nothing; the first reconcile after it sends
exactly one message to the same thread and a second reconcile sends none; a failed send is held as
unknown and not retried; the reviewer path behaves the same; the wake is registered for the reset
and returns to 30 minutes; an unparseable reset time falls back as described. Derive the expected
reset instant from the message text in the test, not from the code under test.

## Why this approach?

- Without it: every limit stops the queue until a person sends "continue", and the wakes during
  the limit are wasted.
- This buys: a stop the factory can tell apart from a real failure and can end by itself. The
  nudge is safe because it goes to the same thread, once, and only after the provider's own reset.

## Files You'll Touch

| Path                                              | Role       | Contains                                  | Edit or Read |
| ------------------------------------------------- | ---------- | ----------------------------------------- | ------------ |
| `factory/plugin.ts`, `factory/plugin.test.ts`     | Adapter    | `reportedActivity`, connected observation | Edit         |
| `factory/native.ts`, `factory/native.test.ts`     | Lifecycle  | `activityReasons`, incidents, nudges      | Edit         |
| `factory/persistence.ts`                          | Records    | Incident reasons and recovery values      | Edit         |
| `factory/watchdog.ts`, `factory/watchdog.test.ts` | Schedule   | The fixed rule and drift detection        | Edit         |
| `factory/README.md`, `factory/foreman.md`         | Operations | Stops, recovery actions, watchdog turn    | Edit         |

Build order: classification, records, nudge, wake, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                       |
| ------------------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.      |
| `git diff --stat af884ca..HEAD -- factory/`             | Revalidate drift in the files above.           |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                    |
| `rg -n "agentError" factory/`                           | No matches before this ticket.                 |
| `rg -n "INTERVAL=30" factory/watchdog.ts`               | One fixed rule.                                |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity |

## Done when

- [ ] A provider usage limit is recorded as `provider-limit` with its reset time, not as
      `worker-error`.
- [ ] After the reset the same worker or reviewer receives exactly one automatic continuation.
- [ ] One watchdog wake lands just after the reset, and the 30-minute rule returns afterwards.
- [ ] Other errors, saved state and unrelated schedules behave as before.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
- [ ] Live proof by the Foreman when a real limit next occurs; it is not claimed before then.

## Notes

The Foreman must confirm two facts live and put them in the brief before dispatch: whether
`agent.start` runs while the model call fails on the limit, and the exact `agentError` shape.
