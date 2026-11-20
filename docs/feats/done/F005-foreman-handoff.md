# F005-foreman-handoff

## Status

- Goal: let a new Foreman thread in the same orb take over a factory whose owner cannot continue.
- Outcome: A new Foreman thread can take over the factory
- Initial priority: P1. Effort: Medium.
- Risk: elevated; a wrong transfer gives two threads control of one queue.
- Depends on: foreman-watchdog-ticket3 (merged). Precedes v1-ticket8, which owns exclusive
  ownership across separate orbs.
- Planned at: `af884ca62b0586646e30743a2fc2258ac68346e6`, 2026-11-14. Local only.

## Why this matters

On 2026-11-14 the owning Foreman thread stopped on a provider limit. The operator started a
replacement thread and gave it the context. That thread could not act: the factory names one
owner, has no transfer operation, and the thread correctly refused to edit ownership in SQLite.
It also started in a new orb and first had to export the whole factory from the old one. The
operator found out hours later.

## Current state

- `factory/native.ts` `assertControlCaller` allows control actions only from the stored owner, and
  refuses any registered worker or reviewer.
- `assertWatchdogCaller` ties watchdog effects to the connected owner. The watchdog schedule lives
  on the owner thread and its prompt names the factory fingerprint.
- `factory/README.md` says automatic fingerprint migration is unsupported and asks for an explicit
  adoption decision. `factory/foreman.md` forbids editing the fingerprint to bypass ownership.
- The Foreman's working notes are an untracked file, `.amp/in/orb-backup/foreman-notes.md`. The
  factory backup does not carry them.
- Factory state lives in the dogfood clone's `.git/factory` in one orb. A thread in another orb
  cannot see it.

## Approach

Add one guarded control action, `handoff`, called from the thread that takes over. It requires the
current owner's thread ID, a nonempty decision, and that the caller is not a registered worker or
reviewer. It refuses while the current owner is observed running. In one commit it sets the new
owner and records the event; then it registers the watchdog on the new thread and clears the
previous owner's schedule when that is reachable, recording an unreachable clear instead of
guessing. Runs, workers, reviewers, attempts and incidents are unchanged; open incidents are
reissued to the new owner.

Store Foreman notes in the factory database through a small `note` action so the backup carries
them, and return the latest notes in the `handoff` result.

## Scope

- In: `handoff`, its guards, watchdog move, incident reissue, the `note` action, tests, README and
  foreman.md.
- Out: cross-orb takeover, fencing and generations; v1-ticket8 owns those.
- Out: restoring state into a new orb; v1-ticket7 owns that.
- Out: any automatic handoff. A person or the taking-over Foreman always calls it.
- Preserve: workers and reviewers can never take ownership.

## Steps

1. **Add the guarded action**. Accept `handoff` with the current owner ID and a decision, refuse a
   wrong owner ID, a missing decision, a worker or reviewer caller, and an owner observed running.
2. **Move owner and watchdog**. Commit the new owner with its event, register the watchdog on the
   new thread, and clear or record the previous thread's schedule.
3. **Reissue open incidents**. Point open incidents at the new owner so their recovery actions
   work, without changing runs, attempts or workers.
4. **Store Foreman notes durably**. Add a `note` action that appends dated notes to the database,
   include them in backup, and return the latest in the handoff result.
5. **Document the handoff**. Describe when to use it, what it refuses and what stays with
   v1-ticket8.

## Test plan

Use the existing fixture hosts. Cover: a valid handoff changes the owner and the old owner's next
control call is refused; a wrong owner ID, an empty decision, a worker caller and a running owner
are each refused with no state change; the watchdog is registered for the new thread and the old
schedule is cleared, or its failed clear is recorded; an open `resume` incident can be resumed by
the new owner and not by the old; a repeated handoff by the new owner changes nothing; notes
survive a reopen and appear in a backup snapshot.

## Why this approach?

- Without it: a stopped Foreman strands the queue, and the only way forward is editing SQLite by
  hand, which the factory documents forbid.
- This buys: one audited operation that moves control and its watchdog together, so there is never
  a moment with two owners or with an owner that no wake can reach.

## Files You'll Touch

| Path                                              | Role       | Contains                           | Edit or Read |
| ------------------------------------------------- | ---------- | ---------------------------------- | ------------ |
| `factory/native.ts`, `factory/native.test.ts`     | Lifecycle  | Caller checks, owner, incidents    | Edit         |
| `factory/plugin.ts`, `factory/plugin.test.ts`     | Adapter    | Control actions and connected tool | Edit         |
| `factory/watchdog.ts`, `factory/watchdog.test.ts` | Schedule   | Registration for a named thread    | Edit         |
| `factory/persistence.ts`                          | Records    | Owner, notes                       | Edit         |
| `factory/backup.ts`                               | Backup     | Snapshot contents                  | Read         |
| `factory/README.md`, `factory/foreman.md`         | Operations | Ownership and adoption rules       | Edit         |

Build order: guards, owner move, watchdog move, incidents, notes, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                       |
| ------------------------------------------------------- | ---------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.      |
| `git diff --stat af884ca..HEAD -- factory/`             | Revalidate drift in the files above.           |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                    |
| `rg -n "assertControlCaller\|assertWatchdogCaller"`     | The current ownership checks.                  |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity |

## Done when

- [x] A new thread in the same orb takes over with one call, and the old owner is refused after.
- [x] The watchdog follows the owner; no schedule is left pointing at a thread without control.
- [x] Workers, reviewers, runs and attempts are untouched, and open incidents are recoverable.
- [x] Foreman notes are in the database and in the backup.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
- [x] Live proof by the Foreman after acceptance: a second thread on the runner takes over a
      paused dogfood factory and hands it back.

## Notes

The Foreman probes before dispatch whether a connected thread can clear another thread's schedule
and puts the observed shape in the brief.
