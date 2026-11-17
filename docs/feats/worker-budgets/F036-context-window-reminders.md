# F036-context-window-reminders

## Status

- Goal: the factory reminds a worker at 60% of its context window and, at 80%, asks the
  operator whether to hand the work off to another thread.
- Outcome: Context-window reminders with an operator-chosen handoff
- Deferred: until the operator asks. Do not admit, brief or dispatch it before then.
- Initial priority: P3. Effort: Medium.
- Risk: elevated; it adds a second way for an attempt's work to move between threads, which the
  one-worker-per-attempt rule does not allow today.
- Depends on: an operator decision on the open questions in Notes.
- Planned at: `ddb0fabf1e2f602308f9295c0e3d77c8bc6863d5`, 2026-11-17. Local only.

## Why this matters

A long worker attempt fills its context window and compacts, and the operator only learns it
from the thread. The operator wants two signals, without a hard stop: going past the window and
compacting stays allowed. At 60% the worker hears it is past half its window. At 80% the operator
decides whether the attempt continues where it is or moves to a fresh thread with a handoff.

## Current state

- Nothing in `factory/` reads a worker thread's token usage; `rg -i "usage|contextWindow"
factory/*.ts` finds only CLI usage text and the provider usage-limit resume in `native.ts`.
- `factory/native.ts` already sends the worker messages (the dispatch prompt and provider-limit
  resume) and the owner messages (`Factory suspicion ...` nudges).
- An attempt has exactly one worker thread (`run.thread`); the Foreman never replaces a worker.
- The `ce-handoff` skill (`/ce-handoff create [focus]`) writes a pointer-first handoff document
  and a `/ce-handoff resume <source>` command for the next thread.

## Approach

Reconcile reads the worker thread's latest assistant-message usage, divides the context it holds
by the worker model's window, and records each threshold once per attempt when it is first
crossed. Thresholds live in the factory definition (`contextReminders: [60, 80]`) so the operator
changes them through the Foreman, and a pinned run keeps the values it started with.

- At 60%: one message to the worker saying how full its window is and asking it to keep its
  report and commits current. It keeps working.
- At 80%: one message to the owner, relayed to the operator as "Would you like me to write a
  handoff and send it to another agent thread?". The operator either pastes a thread link or says
  "yes, spin up a new thread to work on the handoff task". The worker then runs
  `ce-handoff create` for its ticket; the factory delivers the handoff to the chosen thread with
  the `/ce-handoff resume <source>` command and records that thread on the attempt. With no
  answer, the worker keeps going and compacts as it does today.

## Scope

- In: usage reading, the per-model window table, the two thresholds in the definition, the two
  messages, the operator's handoff choice, recording the receiving thread, tests and docs.
- Out: any hard stop or cancel at a threshold, dollar or time budgets, and reviewer threads.
- Preserve: definitions without `contextReminders` behave exactly as today; a reconcile that
  finds no new crossing writes no event and sends no message.

## Steps

1. **Read worker context usage**. Read the worker's latest assistant-message usage and the model
   window, and compute the percentage on reconcile.
2. **Record threshold crossings**. Record each threshold once per attempt at the moment it is
   first seen crossed, and never infer it later.
3. **Send the two reminders**. Send the worker the 60% message and the owner the 80% handoff
   question.
4. **Hand off on operator choice**. On the operator's answer, have the worker write a `ce-handoff`
   document and deliver it to the pasted or newly created thread, recorded on the attempt.
5. **Document the reminders**. Describe the thresholds, how to change them and the handoff path
   in the README and foreman.md.

## Test plan

With fixture hosts and usage shaped like a recorded live reply: a worker at 59% gets nothing, at
61% gets one message, and a second reconcile at 65% sends nothing more. At 81% the owner gets
one question and the worker gets no second message. A pasted thread link and a "new thread"
answer each record the receiving thread on the attempt; no answer changes nothing. A definition
without `contextReminders` and a state file written before this change open and run unchanged.

## Why this approach?

- Without it: the operator finds out about a full window only after compaction has lost context,
  and has no point to choose a fresh thread.
- This buys: every crossing is recorded once by reconcile, the only path that sees usage, and the
  operator, not the model, decides whether work moves threads.

## Files You'll Touch

| Path                                                    | Role       | Contains                               | Edit or Read |
| ------------------------------------------------------- | ---------- | -------------------------------------- | ------------ |
| `factory/persistence.ts`, `factory/persistence.test.ts` | Records    | Definition, run crossings, handoff     | Edit         |
| `factory/native.ts`, `factory/native.test.ts`           | Control    | Usage read, reminders, handoff         | Edit         |
| `factory/setup-factory.ts`                              | Definition | `contextReminders` default and check   | Edit         |
| `factory/README.md`, `factory/foreman.md`               | Operations | Thresholds, changing them, the handoff | Edit         |

Build order: definition and records, usage read, reminders, handoff, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                        | Expected result / action                              |
| ---------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD && git status --short`     | Record the dispatch revision; clean tree.             |
| `git diff --stat ddb0fab..HEAD -- factory/`    | Revalidate drift since planning.                      |
| `rg -n -i "usage\|contextWindow" factory/*.ts` | No usage reading yet, unless another ticket added it. |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory` | Passes; CI runners have no global Git identity.       |

## Done when

- [ ] A worker crossing 60% of its window gets exactly one reminder and keeps working.
- [ ] At 80% the operator is asked once whether to hand off, and no stop or cancel happens.
- [ ] A pasted thread or a new thread receives a `ce-handoff` document, recorded on the attempt.
- [ ] Thresholds change through the factory definition; without them nothing changes.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

Open questions for the operator before this is admitted:

- Where usage comes from. The plugin API records `ThreadMessageUsage` on assistant messages; the
  operator's `context-breakdown` plugin may already compute the percentage. Neither is checked in
  this orb, and a per-model window table is not verified.
- What a handoff does to the attempt. Moving work to a second thread breaks "one worker per
  attempt": decide whether the receiving thread becomes the attempt's worker, starts a new
  attempt, or works outside the factory.
- Whether the worker or the Foreman writes the handoff. The worker has the context; the Foreman
  is outside it.
