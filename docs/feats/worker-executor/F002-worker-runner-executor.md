# F002-worker-runner-executor

## Status

- Goal: keep worker and reviewer tools alive when the Foreman's Amp CLI process is replaced.
- Initial priority: P0. Effort: Small.
- Risk: elevated; the change decides where every worker and reviewer thread executes.
- Depends on: v1-ticket2 (accepted). Complements v1-ticket10, which recovers an outage that still
  happens; this ticket removes the common cause.
- Planned at: `3ec4b7a61e7e938b262369a98a18ac309b2ed494`, 2026-11-14. Local only.

## Why this matters

On 2026-11-14 the worker for foreman-watchdog-ticket3 lost every tool in the middle of attempt 2
and stayed dead for the rest of the ticket. The Foreman reconnected it by hand three times. The
operator wants the factory to run unattended, and every later ticket is exposed to the same loss.

## Current state

`factory/plugin.ts` creates worker and reviewer threads with `executor: "local"`. The plugin type
says `local` "uses the current client as the executor", which here is the Foreman thread's own
headless Amp CLI process. `~/.cache/amp/logs/headless.log` shows that process receiving SIGTERM
twice on 2026-11-14 and being replaced by a new process, once for a CLI update after the orb
resumed. A thread created by the old process then fails every tool with "The Amp CLI process that
ran this plugin agent thread exited". A one-shot `amp threads continue` lends it an executor for
one turn only.

The Foreman observed the alternative live on the same day, from its own thread and not through
the plugin:

- An orb service named `factory-runner`, started with `amp orb service start` in the factory root,
  ran `amp --no-tui --runner-id factory-dogfood`. `list_runners` then reported `runnerId`
  `factory-dogfood` with capabilities `runner`, `any-directory` and `create-worktree`.
- A TEST thread created on that runner ran shell commands in the factory root.
- After `amp orb service restart factory-runner` the runner logged "Resuming 1 thread this runner
  previously served", and the same thread ran shell commands again.

The installed plugin type `AgentThreadExecutor` accepts `{ type: 'runner', id: string }`. Creating
a thread on a runner through the plugin has not been observed. A restart while a thread is in the
middle of a turn has not been observed either.

The run record in SQLite stores nothing about where a thread executes.

## Approach

Add one optional setting to the project definition that names a runner ID. When it is set, create
worker and reviewer threads on that runner. When it is absent, keep `local`, so existing
definitions and saved state behave as before. Record the chosen executor on the run so status and
the database show where each thread runs. If thread creation on the named runner fails, surface it
through the existing creation-failure path; never fall back to `local` silently, because that
would hide the exposure this ticket removes.

The factory does not start, stop or supervise the runner. The operator or Foreman runs it as an
orb service; the README documents the command.

## Scope

- In: the definition field and its validation, executor selection at thread creation, the executor
  on the run record and in status, tests, README.
- Out: starting or supervising the runner, detecting a dead executor, automatic reconnection and
  recovery attempts; v1-ticket10 owns those.
- Out: moving the Foreman thread itself, cross-orb execution and the `orb` executor.
- Out: dashboard and frontend changes.

## Steps

1. **Add the runner setting**. Accept an optional runner ID in the project definition, reject an
   invalid value before dispatch the way an invalid worker effort is rejected, and keep definitions
   without it valid.
2. **Create threads on it**. Pass the runner executor to worker and reviewer thread creation when
   the setting is present, keep `local` otherwise, and let a creation failure block visibly without
   falling back.
3. **Record the executor used**. Store the executor on the run and review records, show it in
   status, and keep saved state from before this change opening unchanged.
4. **Document the runner service**. Describe the supervised runner command, the setting, what was
   observed live and what remains unproven.

## Test plan

Use the existing fixture hosts; start no real runner and create no real thread. Cover: a
definition with the setting creates worker and reviewer threads with the runner executor; a
definition without it still uses `local`; an invalid setting fails before any thread is created; a
creation failure on the runner leaves a visible blocked or uncertain state and creates nothing on
`local`; the run record and status carry the executor; a database written before this change still
opens and its runs read as `local`. Existing tests pass unchanged.

## Why this approach?

- Without it: any CLI update, restart or orb resume during a run strands the worker, and the
  factory sees only an idle thread with an old report.
- This buys: a worker whose executor is a supervised process the platform restarts and that
  resumes its threads. The setting is opt-in and explicit, so a missing runner is a visible
  creation failure, not a quiet return to the fragile path.

## Files You'll Touch

| Path                                          | Role           | Contains                            | Edit or Read |
| --------------------------------------------- | -------------- | ----------------------------------- | ------------ |
| `factory/plugin.ts`, `factory/plugin.test.ts` | Native adapter | Thread creation and its executor    | Edit         |
| `factory/native.ts`, `factory/native.test.ts` | Lifecycle      | Definition parsing, create calls    | Edit         |
| `factory/persistence.ts`                      | Records        | Executor on run and review records  | Edit         |
| `factory/bookkeeping.fixture.ts`              | Fixture host   | Controlled thread creation          | Edit         |
| `factory/README.md`                           | Operator docs  | Runner service and the setting      | Edit         |
| `node_modules/@ampcode/plugin/index.d.ts`     | Installed API  | `AgentThreadExecutor` runner target | Read         |

Build order: definition field, host create signature, records, README.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat 3ec4b7a..HEAD -- factory/`             | Revalidate drift in the files above.            |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                     |
| `rg -n "executor" factory/plugin.ts`                    | One fixed `local` site at thread creation.      |
| `rg -n "type: 'runner'" node_modules/@ampcode/plugin/`  | The runner target exists in the installed type. |

## Done when

- [ ] With the setting present, worker and reviewer threads are created on the named runner.
- [ ] Without it, behavior and saved state are unchanged.
- [ ] A creation failure on the runner is visible and never falls back to `local`.
- [ ] The run record and status show the executor.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.
- [ ] Live proof by the Foreman after acceptance: a real worker created through the plugin on the
      supervised runner keeps its tools across a restart of the Foreman's CLI or of the runner.
