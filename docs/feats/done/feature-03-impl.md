# Feature 03: recover disconnected workers

## Status

- State: verified locally and accepted in both live fixtures. Priority: P0. Category: fix.
- Story: [feature-03-story.md](feature-03-story.md).
- Worker: one Sol 6.1 child at medium effort. No nested delegation.

## Why this matters

Feature 02 completed, but the native adapter lost its connected-thread state handle. Reconciliation
throws before reading the candidate. Replacing the worker would lose ownership and repeat work.

## Current state

`factory/plugin.ts` directly reads `amp.threads.get(id).state.get()`. `factory/native.ts` consults
that state before processing reports. NativeHost has no unknown observation. Watches attach before
the status and paused guards. The dashboard already displays unavailable observations as unknown.

Parent reproduced the failure on the original worker. The same plugin context can read supported
server state with `ctx.tools.call("amp.get_thread_status", { thread: id })`. It returns a structured
object with `metadata.threadID` and `agentState.state`, not just formatted Markdown. Validate both.
Do not invent a private HTTP endpoint or parse the tool's display text.

## Approach

Keep native observations primary. At the adapter boundary, fall back to the supported status tool
when a usable invocation context exists. Without that context or valid evidence, return unknown.
Preserve retryable running ownership for unknown observations. Reuse the observation path for the
dashboard where practical. Contain observer attachment failures without losing the ability to retry
or pause. Explicit control reconciliation must recover a disconnected candidate after reload.
Do not add polling infrastructure or a new state service for this bounded fix.

## Scope

- In: `factory/native.ts`, `factory/native.test.ts`, `factory/plugin.ts`, an adapter test file if
  needed, and `factory/README.md`.
- Out: SQLite, frontend changes, new dependencies, backup, worker retirement, remote changes,
  broad lifecycle rewrites, and changes to these acceptance criteria.

## Steps

1. Add a failing behavioral regression for disconnected observation followed by recovery.
2. Implement the guarded native fallback and preserve ownership while observations are unknown.
3. Verify negative controls and existing correction, permission, and revision checks.
4. Return a revision-bound candidate through the factory. Parent verifies the original fixture.

## Test plan

- Native read fails; server confirms the requested worker idle; valid candidate is verified once.
- Unavailable context, thrown fallback, malformed payload, mismatched ID, and unknown state never
  create, resend, or accept. A later valid observation recovers the same worker.
- Connected running worker does not consult fallback. Idle without report remains unaccepted.
- Observer failure does not break status or pause. Failed attachment can be retried.
- Verification failure still corrects the original worker, and repeat acceptance is idempotent.
- Run focused tests, full `bun test`, strict TypeScript with the installed SDK, and whitespace
  checks.

## Done when

Story criteria pass locally. Parent reruns the preserved Feature 02 fixture through the actual
plugin, accepts its original candidate, and confirms no second worker or prompt was created.

## Throughput checkpoint

- Blocking first step: snapshot exact current uncommitted source into the disposable fixture.
- Independent workstreams: none. Exactly one implementation child at a time.
- Shared mutable state: child owns its worktree; parent owns this checkout and original fixture.
- Smallest safe decomposition: one worker fixes the native adapter and reconciliation contract.

## Notes

Read poteto-mode and perform the work directly. No extra seats or panels. Keep full logs in the
fixture, and return concise failures and verification results. Parent owns commits to this repo.
No push, deployment, external ticket write, or worker deletion is authorized.

## Drift log

2026-11-13. Parent reproduced the native failure and confirmed supported structured server status
through the plugin. No replacement worker was started during diagnosis.

The first candidate passed 52 local tests and strict SDK checking. Live acceptance then exposed
the synchronous verification command blocking the plugin heartbeat. Instrumentation confirmed
the fallback returned matching idle state before the plugin stopped responding. No acceptance,
replacement, or duplicate delivery occurred. Both fixtures were paused, and the same worker was
asked to make verification asynchronous and prove event-loop responsiveness before resubmission.

The same worker's continuation reached `Executor disconnected` before making further edits.
Server status confirms failed executor startup with the pending tool turn still recorded.
No replacement was created. Native messaging did not reconnect execution. The parent verified
`amp threads continue` exists, but using CLI agent continuation requires explicit user permission.
The initial prototype is committed separately; the recovery candidate remains uncommitted here
because its live acceptance failed. No next backend ticket has started.

After explicit authorization, the parent resumed the same worker with `amp threads continue` in
a supervised service. The worker amended its candidate with asynchronous verification and a
regression that requires a pending command to yield to the event loop. No replacement was created.

Parent verification passed 53 tests, 1,072 assertions, strict SDK TypeScript, and whitespace checks.
The actual refreshed plugins accepted the original Feature 02 revision and the amended Feature 03
revision. Repeated reconciliation left each fixture with exactly one creation, one delivery,
one acceptance, and one revision-ledger entry. Root HEADs matched the original candidates, and
both queues were paused afterward. Full logs remain under the two scratch fixture directories.

This proves explicit post-disconnect reconciliation, not automatic executor reattachment.
Background recovery still lacks the invocation context required for the supported status fallback.
