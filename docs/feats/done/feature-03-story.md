# Feature 03: recover disconnected workers

As an operator, I can reconcile a saved worker after its local connection disappears, so completed
work is verified without replacing the worker or repeating delivery.

## Acceptance criteria

1. Connected workers continue using native Amp state observations. A disconnected read can fall
   back to Amp's supported server-status tool through plugin invocation context, without inference.
2. Only a validated status for the requested thread is trusted. Unavailable, malformed, mismatched,
   or unrecognized observations remain unknown. Unknown is neither idle nor acceptance.
3. Unknown observations retain the original running record, attempt, report, worktree, and thread.
   A later reconcile can recover it. No replacement worker or duplicate prompt is created.
4. Server-confirmed idle candidates pass the existing revision, scope, clean-tree, verification,
   and integration gates. Idle without a report does not imply acceptance.
5. Restart and observer attachment failures cannot prevent status or pause. Repeated reconciliation
   after acceptance does not repeat integration or evidence recording.
6. Lifecycle decisions use Amp APIs and structured events, not provider payloads or assistant prose.

## Evidence

The original Feature 02 worker is preserved in the parent's disposable fixture. On 2026-11-13,
native state returned `thread.state is only available for connected threads`, while
`ctx.tools.call("amp.get_thread_status", { thread: id })` returned the same thread with idle state.
Its revision-bound candidate report remains present and the queue remains paused.
