# Factory prototype

The dispatcher uses Bun SQLite persistence and native Amp thread APIs. Cross-orb code transfer,
worker retirement, and dashboard chat are not implemented. Remaining stories live in
[stories.md](../docs/stories.md) and their tickets in [the backlog](../docs/backlog.md).

The [Foreman prompt](config/agents/foreman/agent.md) defines the current orchestration
procedure. It is a reusable prompt, not execution authority. Generated installations register the
restricted `factory-foreman` mode described below; the source-maintenance registration remains
separate and does not silently change an existing owner.

## Take over a stopped Foreman in the same orb

In a replacement thread connected to the same repository and Git storage, call factory control
with `action: "handoff"`, `owner` set to the exact current owner thread ID from status, and a
nonempty `decision` explaining the takeover. This is explicit recovery, never automatic adoption.
The current owner must be observed idle, stopped on an error, or awaiting approval. Running and
unknown activity are refused. Workers and reviewers, including retained checkpoints, cannot take
ownership. An uncertain schedule effect must be resolved on its recorded thread first. A changed
root or Git storage fingerprint is refused; this procedure cannot release a replacement restore.

The existing coordinator lock serializes the transfer. One SQLite commit changes the owner,
records the decision, and reassigns open incidents without changing their IDs. Runs, workers,
reviewers, attempts, progress clocks, enabled state, and execution permissions stay unchanged.
Open incidents are reissued to the new owner. Use their exact current IDs for recovery. Former
owners cannot control the queue. The operator decides any further guarded handoff.
Repeating the same handoff request from the new owner is a no-op.

The new owner inspects the old thread's schedule and clears only this factory's fingerprinted
watchdog using the schedule tools' `thread` parameter. Every clear is followed by inspection,
including after a lost acknowledgment. A targeted null or a foreign registration confirms that
this factory's old watchdog is absent. Foreign registrations remain untouched. A failed read,
failed clear, unrecognized reply, or read-back still showing the old fingerprint records cleanup
as unreachable. A later successful inspection can settle a lost clear acknowledgment.
An unconfirmed clear does not block the new owner's watchdog, start, or a further guarded handoff.
`foreman.handoffs` records `clear: "unreachable"` and its `problem` separately from new-owner
monitoring. A stale former-owner wake cannot control the queue or perform watchdog effects.
Connected reconciles retry all unresolved former-owner cleanups, except a thread that now owns the
factory again. Unchanged retries write no cleanup commit or event and send no new alert.
Each handoff reserves at most one cleanup warning through the durable notification budget,
including unknown sends. Cleanup warnings can occur while paused; paused or completed
factories still do not install a new watchdog. Never edit SQLite or clear an unrelated schedule.
Live cross-thread clearing still needs Foreman acceptance.

Use owner-only `action: "note"` with nonempty `message` to append private dated working notes.
Notes survive reload in SQLite, travel in the existing private backup snapshot, and appear in
`foreman.notes` in the handoff result. Notes are not dashboard data or public event details.

## Run the weekly failure audit

Once a week, supply `TYPESAFE_API_KEY` through the process environment. Do not put its value in a
command, transcript, or file. From this checkout, run the audit against the private factory
directory of the repository you want to audit:

```sh
bun factory/audit.ts /path/to/repository/.git/factory
```

The default range is the past seven days, ending when the command starts. To repeat a range, pass
explicit ISO timestamps. The start is inclusive; the end is exclusive:

```sh
bun factory/audit.ts /path/to/repository/.git/factory 2026-11-09T00:00:00Z 2026-11-16T00:00:00Z
```

The collector reads SQLite events and legacy post-graft verdict files without changing them. Event
timestamps take precedence; verdicts without an event use file modification time. Copies in verdict
files, review events, and rejection events count once. Each finding becomes one record. A rejected
gate uses its `<log>.excerpt.json` companion, containing an explicit outcome, exit status, and the
same stdout and stderr tails sent to the worker. The tails share an 8,192-byte budget and are cut at
line boundaries. Noisy stderr cannot displace a stdout diagnostic. When a rerun log exists, the
collector uses that attempt's rerun excerpt rather than the first failure. Candidate verification
writes the final companion before
recording its decision; the audit only reads it. Only `gate-failed` excerpts are classified.
The companion also records `gate-passed` for successful gates, including successful F019 retries.
Logs without a companion retain a bounded combined tail locally and stay `unsorted` because their
stream boundaries are unknown. Invalid companions and stops without
structured findings also remain local `unsorted` records with a reason. Unknown or missing outcomes
and contradictory exit statuses make a companion invalid. The other outcomes stay local and are
never sent to the API:

- `gate-not-run` means a candidate revision, clean-tree, or allowed-path precondition failed before
  execution. Its reason is
  `Gate not run: candidate revision, clean tree or allowed-path check failed`.
- `post-gate-changed` means the command passed but left the worktree dirty or moved HEAD. Its reason
  is `Post-gate clean tree or candidate revision check failed`.
- `gate-passed` is not a failure finding. If referenced by a failure event, its reason is
  `Gate passed: no failed gate finding`.

Only severity, location, evidence, and correction text, or a bounded gate excerpt, leave the orb.
The destination is `POST https://api.typesafe.ai/v1/systemone`, using `jev-latest` and fixed area,
mistake, layer, impact, and none-fits questions. Ticket metadata, worker briefs, transcripts, and
full logs are not sent. The key is used only in the authorization header and is redacted from
finding text and audit output. HTTP bodies and transport errors are never copied into output.
Finding text can quote private code and file names; review that disclosure before operating this
command in another repository.

Each record gets at most three requests. HTTP 429 and 529 wait one and then two seconds before
retrying. Each request has a 30-second timeout and refuses redirects. Other HTTP errors, invalid
answers, area confidence below 0.7, and none-fits probability at least 0.5 yield `unsorted` with a
reason. A missing key fails before collection or requests. The command still writes a partial
ledger when individual classifications fail; inspect `unsorted` even when the command exits zero.

The command writes a new `audit-<date>-<unique-id>.json` ledger with owner-only permissions in the
private factory directory. It contains the range, every record, validated answers and
probabilities, thresholds, and bucket summaries. Summaries include counts, tickets, mean impact
on the 0-to-4 rubric, and the five most frequent finding locations without line numbers. Retain
the ledger privately; do not commit it or serve it through the dashboard.

Copy the printed brief into one `moonshotai/kimi-k3` thread with access to the code and
ledger. Ask it to audit the recurring boundaries and concepts, not repair individual tickets.
Inspect its evidence and commit the returned report under `docs/audits/<date>.md`. The script
never creates threads, installs schedules, changes acceptance, or acts on audit recommendations.

## Project definition and reload

The project owns one version-1 definition. It is the directory `factory/config/`, or one legacy
flat file: `factory/definition.yaml` or `.factory.json`. A flat file keeps loading exactly as
before. The directory beside a flat file is a conflict, not an override order, and the error names
both. Beside a flat file, a directory without `factory.yaml` may hold only the bundled Foreman
prompt as a bare body; front matter on it is refused too, since the flat file would ignore it.
Any other file, valid or not, is refused at load by path, so `--check` fails too; that
includes the leftovers of an interrupted migration, which `--migrate` completes.

```text
factory/config/
  factory.yaml                  version, capacity, mode, prd, tickets, scope, verify, permissions,
                                ticketFiles, backup, bookkeepingSHA256, watchdog, providerLimit,
                                hooks
  agents/foreman/agent.md       front matter: model (orchestratorModel). Body: the Foreman prompt
  agents/implementer/agent.md   front matter: model, effort, runner (workerModel, workerEffort,
                                workerRunner). Body must be empty
  agents/light-implementer/agent.md
                                front matter: model, effort (lightWorker). Present with capacity 2
  agents/reviewer/agent.md      front matter only. The file's presence turns review on
  agents/observer/agent.md      front matter: model, effort (observer). Optional; see below
  runners/<name>.yaml           setup, setupTimeoutMs; <name> is the implementer's runner ID,
                                or `local` when it names none
  checks/<name>.yaml            command, order, required (default true), timeoutMs (default
                                600000). Optional; replaces verify in factory.yaml
  automations/<name>/automation.md
                                front matter: schedule (5-field UTC cron), enabled (default
                                false). Body: the prompt. See Scheduled automations
```

### Native hooks

No hooks are configured by default. An authored definition can declare one local action:

```yaml
hooks:
  - event: agent.start
    action: create-marker
    name: turn
    timeoutMs: 1000
```

`name` is a lowercase alphanumeric label with optional hyphens, up to 32 characters.
`timeoutMs` is a required integer from 1 to 5000. One deadline covers permission checks and the
action. A late permission response cannot start the action or hold a queued pause. The action
invokes a fixed `mkdir` with no shell or inherited environment. Its only effect is one empty
directory named `<name>-<event-hash>` inside the opened `hook-markers/` directory. The child uses
an inherited Linux directory descriptor, so replacing `hook-markers/` cannot redirect a write.

Only a valid Amp `agent.start` message ID for the current owner can trigger a hook. The factory
must be enabled, the owner's installed policy must verify, and the current definition must both
allow execution and still match the accepted hook. Use `reload` to accept a new declaration.
Removing or changing a declaration stops the old action immediately. Install, check, refresh,
read, reload and ordinary reconcile never run hooks. Hooks cannot run project commands, read
secrets, accept candidates, dispatch workers or change ownership.

SQLite records the claim before the process starts. Reconciliation records abandoned claims as
`hook-uncertain` without replaying them. `hook-refused`, `hook-failed`, `hook-timed-out` and
`hook-succeeded` also consume the event. Changes to the hook or marker directory do not make an
already claimed event eligible again. Operator event history shows the outcomes without exposing
the marker label, the message ID or its content.

### Check files

With `checks/`, the gate runs each check as its own command, in `order` and then by name, each
under its own `timeoutMs`. It keeps going after a failure, so every result is known, and records
`{name, required, status}` per check, where status is `pass`, `fail` or `timeout`. The gate passes
only when every required check exits 0. A check that times out, is killed or cannot start is a
failure, never a skip. An advisory check (`required: false`) never rejects. Its result stays in
evidence and the feed; an accepted worker gets no message about it, since it has nothing to act
on. When the run is rejected, by the gate or by review, the repair feedback carries each failed
advisory check's tail. The rule reads those per-check results, never log text.

The loader refuses, naming the file: an empty `checks/`, one with no required check (that gate
could never fail), a linked or non-regular check file or `checks/`, a subdirectory or a
non-`.yaml` file inside it, an unknown key, a missing or empty `command`, a missing `order`, a
non-integer or non-positive `order` or `timeoutMs`, invalid YAML, `checks/` beside `verify` in
`factory.yaml`, and a directory with neither. `checks/` beside a flat definition file is refused
like any other config file. Without `checks/`, the flat `verify` string gates exactly as before:
one command under a 600 000 ms timeout. Checks are pinned with the definition, so an edit or a new
check changes nothing for an active run until `reload`.

An optional `capability` on a check declares the installed tool that command uses. For example,
`checks/contracts.yaml` can contain:

```yaml
command: verification check contracts
order: 1
capability:
  tool: verification
  versionArgs: ["--version"]
  coverage: ["public API contracts"]
```

Use the project's existing command and its documented read-only version arguments. The factory
does not install tools, replace harnesses, add formal models, start watchers, or infer coverage.
`coverage` is a nonempty list of authored scope labels, not measured code coverage. `tool` and
each version argument must be nonblank strings. Unknown capability keys and incomplete
declarations are refused at load. Capability declarations share the check's `required` role and
are covered by the definition digest and immutable pin, not a separate configuration format.

At a gate, discovery resolves an external executable with Bash `type -P` in the check's login
shell and probes its version. The probe has the smaller of `timeoutMs` and 30 seconds, followed
by the check's own timeout. Missing executables, failed probes, and empty version output fail
that check without running its command. An unavailable required tool rejects even if every
advisory check passes. An unavailable advisory tool remains a reported advisory failure.
Discovery failures do not trigger the flake rerun. Successful discovery runs the authored check
command once per gate execution; the existing rerun policy still applies to command failures.

Private gate evidence records each check's exact command and revision. Declared capabilities
also record the tool, resolved executable, observed version, and authored coverage. An unavailable
tool has a null executable or version rather than an inferred success. Evidence stays bound to
the attempted revision; a rebase requires a fresh gate and cannot reuse a stale pass. Setup
`--check` uses the same discovery without running check commands or recording acceptance.
Status, effective-definition reads, dashboard reads, and unchanged reconciles never probe tools,
rerun checks, poll CI, or start a second watcher. Undeclared checks and verify-only projects keep
their existing behavior and make no new version or coverage claim.

A rejection lists every check with its status and time, then each failed check's own stdout and
stderr tails. F008's 8192-byte budget is split evenly across the failed checks. A review
rejection of a passed gate re-cuts the failed advisory checks' tails from that gate's evidence
record to the same budget. The F019 rerun
still runs once when a required check exits non-zero; a gate with a timed-out, killed or
undiscovered required check is not rerun. The gate evidence record holds JSON with each check's
command, revision, optional capability, status, duration and output tail. The status feed carries
each ticket's last gate as `checks: {attempt, results}` with
names, `required` and statuses only, and the kit page draws its verify chips from it. A flat
`verify` gate is recorded there as one required check named `verify`; its log, excerpt, evidence
and feedback stay as before.

The loader composes these files into the flat object that `factory/definition.schema.json`
describes and validates that object with the same rules, so nothing downstream of it changes.
`factory/config.schema.json` lists the setting names each file may hold. Checks refuse, naming
the file, an unknown setting, an unknown file or directory (even an empty one), a missing
`factory.yaml` or implementer, a runner file that no agent names, an implementer naming a runner
with no file, and a non-empty implementer, light-implementer, observer or reviewer body (nothing
reads those bodies yet). A `factory/config` that is a link, or sits under a linked `factory`, is
refused before anything is read, and migration also refuses a linked `factory` that has no config
child yet, before it writes anything, so it cannot alias a path a worker may edit or reach
outside the repository. Instructions remain in the Markdown file referenced by `prd`.
The optional `observer` setting (`model` and `effort`, in the flat file or in
`agents/observer/agent.md`) names what `register-observer` creates; without it the observer is
`anthropic/claude-haiku-5-5` at high effort. Like other agent settings it is part of the accepted
definition: an edit changes nothing, including after a restart, until `reload`, and an older
accepted definition without it keeps the built-in observer. Registration records the thread,
model and effort. Authorization and the observer's two allowed actions do not change.

The digest covers every file under `factory/config/` in sorted path order, each with its path,
plus the `prd` instructions, so changing any one byte changes it. Workers may not edit anything
under `factory/config/`: a scope entry inside it is refused, and the changed-path check rejects a
candidate that touches it even when `factory/` is in scope. Checks reject unknown settings,
unsupported capabilities and unsafe paths.

Run `bun factory/setup-factory.ts --repo /local/project/root --migrate` to write the directory
from a validated flat definition and then remove the flat file. Migration refuses to overwrite: a
file that already holds different content, or a file it does not plan to write, stops it before
anything is written. The one exception is an existing Foreman prompt without front matter, which
keeps its body and gains the model. `factory.yaml` is written last, so a half-written directory is
never loaded as a definition. Each file is staged in its own fresh scratch file beside `factory/`,
never one reopened for writing; a retry after an interruption only unlinks leftover scratch. The
written directory is composed once more before the flat file is removed. Repeating migration is
safe, including recovery after an interruption, and a migrated project is only revalidated.
Checks, refresh, status and ordinary reads never migrate definitions.
Use `--check` to validate authored settings and `--effective` to inspect the secret-free loaded
digest, permissions and capabilities. The dashboard's `/api/definition` uses the same loaded view.

The first enabled lifecycle operation accepts the initial definition into coordinator SQLite.
After that, call the native control tool with `action: "reload"` to accept validated edits for
future runs. Restarting the plugin or calling start does not implicitly reload. Until reload,
effective views and the dashboard publisher keep using the previously accepted settings and queue
path. Invalid or worker-issued reloads are refused. Permissions are always checked from the current
authored definition, never granted by a historical pin. Backup settings remain independently gated.

Runs retain only their definition digest; immutable settings and instructions are stored once per
digest. Reload never changes active scope, checks, review policy or reviewer requirements. Worker
messages contain the digest and scoped task, not the entire PRD; cold reviewers receive the pinned
requirements. Explicit `retry-setup` alone uses freshly validated settings for the retried
preparation and its worker, without reloading future dispatch. Commit tracked definition edits
before dispatch or retry. Pinning does not relax landing checks: a dirty or advanced root still
blocks an active candidate whose integration base no longer matches.

## Scheduled automations

An automation is a prompt the owning Foreman thread receives on a UTC cron schedule, such as a
codebase pulse or a weekly failure audit. It is one more file kind in the config directory,
parsed by the same front-matter reader as every other Markdown file:

```text
factory/config/automations/<name>/automation.md
  front matter: schedule  5-field cron (minute hour day-of-month month day-of-week), UTC, quoted
                enabled   true or false; default false
  body:         the prompt, sent as `Factory automation <name>` and then the body
```

A field is a comma list of `*`, `n`, `a-b`, `*/s` or `a-b/s`. Names such as `jan` and a step on
a bare number are refused, as is a date no month has, such as 31 February. When both day fields
are restricted either may match, as in Vixie cron.

The loader refuses, naming the file: `automations/`, an automation directory or `automation.md`
that is a link or not a regular file; any other file or directory inside `automations/` or an
automation directory; an automation directory without `automation.md`; an unknown front-matter
key; a missing, empty or invalid schedule; an `enabled` that is not a boolean; an empty body;
malformed front matter; and `automations/`, even empty, beside a flat definition. A refusal stops
every load and reconcile, so a file the loader cannot read is never half-applied.

`reload` loads the declared automations into durable state, as it does the rest of the definition,
in the same SQLite transaction as the accepted digest, and so does the first `start`: after an
interruption the old digest has the old automations or the new has the new, never a mix. The
first `start` fits the schedule to the automations it is about to accept, so an enabled one is held
to the same check as work: an unrelated schedule or an unconfirmed set refuses the start, leaves the
factory disabled and saves no definition or automations.
Editing, adding or removing a file changes nothing the clock sends until `reload`, also after a
restart. The first `start` loads them with the first accepted definition. Each automation keeps
its authored `enabled` as a default, the control override on top of it, when it was armed and its
last run and outcome. The override wins until a reload finds a different authored `enabled`; a
reload with the same value keeps it. `start` and `reload` fit the schedule in the same call.

There is one clock. The factory keeps its single Amp schedule and every connected owner wake,
or observer wake when an observer is registered, checks which enabled automations are due. No
automation has its own Amp schedule. The schedule uses the shortest interval needed by enabled
automations or stall checks, capped at the watchdog's 30 minutes. While an automation is enabled a
started factory holds the schedule even with no active work, and with none enabled the schedule
follows work as before. The change goes through the watchdog reconcile, so its conflict,
drift and unknown-outcome handling apply unchanged: an unrelated schedule on the thread is
preserved and recorded as a problem, an unconfirmed change is recorded `unknown`, and the
override persists either way. While an automation is enabled the schedule is not anchored to a
pending provider reset, so automations keep waking; a continuation is still gated by its own
reset time at the first wake after it. A read-back whose start is still in the future, whether
the anchor was confirmed or not, does not confirm the change, even when the period is unchanged;
the monitor stays `unknown`.

An automation is due when its latest scheduled minute at or before the wake is not before the time
it was armed (loaded enabled, or switched on) and is later than its last run. Missed wakes
collapse into one run, never a burst, and a wake in the same minute sends nothing more. A paused
factory, a wake with no owner or observer caller and `permissions.execute: false` send nothing.
The attempt is recorded `unknown` before the send and `sent` after it, so a crash or a lost reply
leaves `unknown` and the same time is never retried; the next scheduled time is a new run.

An automation only sends text to the owner thread. It never creates a thread, admits, starts,
resumes or dispatches work, and no run record changes.

Owner-only control actions, each refused for any other caller, including workers and the observer,
with no state change:

| Action               | Input  | Effect                                                         |
| -------------------- | ------ | -------------------------------------------------------------- |
| `automations`        | none   | List name, schedule, enabled, last run and outcome             |
| `automation-enable`  | `name` | Set the override on; refit the clock (needs connected tools)   |
| `automation-disable` | `name` | Set the override off; refit the clock (needs connected tools)  |
| `automation-run`     | `name` | Send once now, enabled or not; an unknown outcome is an error  |

A repeated enable or disable writes no event but still lets the clock converge. An unknown name is
refused.

## Durable coordinator state

### Planned intake and admission

Authored tickets may set `intake: "planned"` and a nonblank, explicitly public `outcome`.
They retain the same canonical `id`, private `brief`, and `after` prerequisites as queue entries.
Reload imports or refreshes these records in the existing SQLite tickets table without dispatch.
Restart, accepted prerequisites, and removing `intake` from a later refresh cannot admit them.
Authored `intake: "admitted"` is rejected. Entries that have never had an intake state retain
legacy queue behavior.

The owning Foreman calls the native control tool with `action: "admit"` and one `ticket` ID.
All `after` prerequisites must already have durable accepted runs. Workers, reviewers, missing
callers, and nonowners cannot admit work. Repeating admission is a no-op. Admission freezes that
ticket's scoped record against later planning refreshes. Owner `reload` may replace this record only
when releasing a `brief-incomplete` refusal, retaining admission and recording the new ticket in a
`configured` event. Admission neither starts a paused factory nor creates a worker; the ordinary
per-lane loop dispatches admitted work afterward. Existing accepted evidence and definition
migration rules remain unchanged.

The read-only `/api/status` feed exposes `stage: "planned"` before admission and `"queued"` after
admission until execution begins. Each task includes `outcome`, or `null` when no public outcome was
authored. It never falls back to the private brief. Top-level `counts` contains separate `planned`,
`queued`, and `accepted` totals. Reads do not import or refresh records. Importing the full planned
inventory remains a separate Foreman action after acceptance.

### Ticket file sync

The optional definition setting `ticketFiles` names a directory relative to the repository root,
such as `docs/feats`. When set, `reload` and every owner `reconcile` read the ticket files below
it and merge them into the queue before tickets are refreshed. A ticket file is a Markdown file
named `F<NNN>-<slug>.md` whose H1 equals its name and which is not under a `done` directory. A
ticket file with no queue entry of the same id becomes a `planned` row: its steps are the bold
labels of the numbered list under `## Steps`, its outcome is the `- Outcome:` line under
`## Status`, and its brief is `Implement <path>`. A queue entry of the same id merges field by
field: the ticket file owns the steps and outcome, and the Foreman's brief, `after`, `size`,
`risky` and lane come from the queue file. Deleting a merged row's file reverts the row to the
queue entry alone.

A synced row is always `planned`: no ticket file content can produce an admitted row, change an
admitted row, or start a worker. Admission stays the owning Foreman's separate action. A synced
row whose file is gone or has moved to `done` is removed, unless it is admitted or has a run;
those rows are never changed. A ticket file that cannot be read (no Outcome line, no bold step
labels, an H1 that differs from the name, or a duplicate id) is skipped, named with its reason in
`status` under `skippedTickets`, and stops nothing. Only the id, step labels, outcome and path
leave the file; Approach and other prose never reach rows, status, or the feed. When the setting
is absent nothing is synced or swept.

### Storage and recovery

The repository Git directory contains `factory/state.sqlite`, with schema version 2. Coordinator
ownership, retained ticket definitions, worker runs, and ordered events live there. Every lifecycle
transition commits its state and event in one short transaction. Worker calls and asynchronous
verification run outside transactions. The existing poteto bookkeeping lock and revision ledger
remain separate and unchanged. Databases and SQLite journals stay inside Git metadata, not commits.
Mutating lifecycle operations upgrade version-1 SQLite transactionally; read-only checks do not.
Private backup supports both versions and records the snapshot's actual version in its manifest.

The first mutating lifecycle operation imports validated `state.json` and `events.jsonl` records.
The original files remain intact for recovery. Later operations use SQLite and ignore stale legacy
files. Removing a ticket from the manifest does not discard its claimed worker or accepted evidence.
Ambiguous creation and delivery stay parked instead of creating replacement workers.

The second failed verification or review attempt escalates to the Foreman and holds the queue.
Rejection at attempt four or later sets the run to `parked` and records one operator-alert intent
in the same transaction. Parking releases independent tickets; dependents still require `done`.
Both blocked repairs and parked runs retain the original worker and repair checkpoint.
The owning Foreman can call `resume` with `ticket`, the current `incident` ID, and a nonempty
`decision` after inspecting the evidence. At attempt four or later, the plugin also requires a
human confirmation dialog (`requireHuman: true`). Model-supplied decision text is not approval.
The platform's authenticated responder user ID is bound to the exact owner, ticket, rejected
attempt, incident, candidate base and current integration HEAD. Missing attribution, denial,
cancellation or any changed binding refuses without resuming. The dialog holds no coordinator
lock. Native resume revalidates the binding and records attribution in `repair-resumed` atomically
with consuming the incident and advancing the existing checkpoint. It cannot be replayed after
success or restart, and a failed transaction consumes nothing. The second-rejection Foreman
checkpoint below the cap is unchanged. This queues the same worker at the next attempt.
It does not accept code or start a paused factory. Use `start`
separately when paused. Resumption requires an idle worker and its registered clean worktree.
Blocked repairs require an unchanged integration base. A parked repair allows a clean descendant
integration HEAD: resume validates the original incident, atomically repins the checkpoint base,
and tells the same worker to rebase onto it before submitting another candidate. Rewound or
unrelated histories are refused. Old two-attempt review blocks can recover from matching durable
review events and the candidate report. Missing recovery evidence fails closed. Subsequent
candidates still require the normal gates. A parked run waits for an operator decision. Its exits
are owner `resume`, which requires no other active or uncertain work, and `record-landing` once the
operator lands the candidate outside the factory. Its stage is `parked`. A later
rejection parks it again rather than sending an automatic correction.

Actionable stops persist an `incident` in the run, in the same SQLite transaction as the stop event.
Its ID identifies the ticket, attempt and base; its owner names the current recovery recipient.

Before setup or worker creation, dispatch checks the local Markdown ticket pointer following a
leading `Implement` in the brief. Other Markdown mentions, including files to create, are not ticket
pointers. That pointer must exist in the Git base tree. Dispatch also requires a pinned definition,
nonempty scope and verification command, and nonblank insights for completed dependencies.
Missing facts record a `brief-incomplete` incident and hold the queue without creating a worktree
or thread. The reason names missing facts without quoting the brief.
Fix the queue or definition and commit tracked changes. For a done dependency with empty insight,
the owning Foreman calls `record-insight` with its `ticket` ID and nonblank verified `insight`.
This fills only missing accepted evidence; it cannot replace nonempty evidence. Repeating the same
value is a no-op. It does not dispatch, change acceptance, or release the dependent refusal.
Then call owner `reload` to release the refusal for rechecking on the next dispatch. The refused
ticket must remain in the authored queue; removing it does not cancel its admission or release the
hold. Reload preserves admitted intake and does not start a paused factory. Non-owner definition
reloads do not release refusals or replace admitted records. Other stops and existing workers are
unchanged.

Control `status` adds a compact, static `lifecycle` reference from `runLifecycle` in
`persistence.ts`.
It lists each kind's admitted actions, admission holds, stops, incident reasons, recovery values and
conditional exits. The same table supplies native stop, interruption, activity and kind-admission
rules. It is not saved in SQLite and includes no private briefs, report paths or thread content.
Exit conditions describe required evidence; they do not grant permission or bypass validation.
`record-landing` includes checkpoint-less target changes and multi-commit candidates.
`record-merge` records an already done ticket without reopening it.

Every kind, stop and exit declares one `actor`: `computer`, `model`, `foreman` or `operator`.
Actors describe responsibility, not authorization. `parked` and its resume exit require the
operator's decision; `brief-incomplete` and `record-insight` belong to the Foreman.
The walking test checks actor coverage, including exitless stops and owner actions.
Status and the dashboard also publish the ordered `pipelineSteps` from `pipeline.ts`.

| Pipeline step  | Actor    |
| -------------- | -------- |
| worktree       | computer |
| setup          | computer |
| builder thread | model    |
| report.json    | model    |
| gate           | computer |
| cold review    | model    |
| ff-merge       | computer |

New incidents record `cause` with the known causing thread ID and its `worker` or `reviewer` role.
Stops before thread creation, target changes and review identity changes have no causing thread.
An identity mismatch alone does not establish which thread caused it.
Legacy incidents remain unchanged and show no failed-thread link. Notices name the saved role,
never a role inferred while reading the stop.
The read-only dashboard retains `thread` and adds separate `workerThread`, `reviewerThread`,
`stop`, `parked` and `rejections` fields. Rejections pair the recorded review creation with its
matching issues verdict in event order. Only attempt numbers and validated thread IDs are public;
briefs, report paths and findings stay private. Stage badges show actors and link to their own
threads; earlier rejections link to their reviewers.
The feed declares `stages` once per response, in order with each default actor. Each task adds
`stage`, `actor`, `stageSince`, `step` (the index into `pipelineSteps`, or null), `rejectedBy`,
`clearsAt` for a known provider reset, `acceptedAt` and `summary`, all from `runStage` and saved
run fields. `kind` is the run's saved kind and `stopName` the declared stop that holds it (null
when none does); both are keys of the declared lifecycle table, null before a run exists.
Accepted and landed runs keep the worker's `attempt`; older done runs show none.
The status action returns the same `stages` list and a `stage` map by ticket. The page draws its
stage badges and stages-done count from `step` and `stage`. The feed has no five-value public
status. `activity` (`working`, `idle`, `blocked` or `null`) is the live observation of a run still
in flight, and the page says that word, or else the status the `stages` list declares for the
run's `stage`. A dashboard observation saved before `activity` existed has none, so it reads as
unobserved. Stop notices name the stage and its actor. The worker report's `insight` stays private.
A worker writes one JSON object to its `<ticket>.report.json`. Both report kinds require the
current positive integer `attempt`. A `candidate` requires a full 40-digit hexadecimal Git
`revision` and a nonblank `insight`. The factory keeps at most the first 1,000 characters of
`insight`. A `blocked` report requires a nonblank `reason`. New acceptance evidence excludes
unknown keys. A valid report for a different attempt is ignored. A malformed report names the
invalid field in private repair feedback and follows the existing same-worker rejection and
escalation rules. Reconciliation does not reject the same unchanged malformed file twice.
A report may add an explicitly public `summary`; acceptance curates it like a title with
`publicSummary` (one line, at most 120 characters, refused if it holds a path, URL or thread ID)
and saves only the result on the done run. The feed publishes that field or `null`; landings and
older runs omit it.
A first rejection sends the same worker back with no stop. `reject` saves the failed attempt as
`rejectedAttempt` and records a `rejected` event whose detail is
`{ reason, attempt, nextAttempt, evidence }`: `report-invalid`, `gate-failed`, `review-rejected` or
`target-changed` (a merge rejection) from `rejectionReasons`, the failed attempt, and private
evidence. `nextAttempt` records the new worker attempt. Until the repair message is sent, the feed
publishes `repair: { reason, attempt }` without claiming live activity. Delivery and acceptance
clear it to `null`. A later resume has moved past `rejectedAttempt` and never reuses the repair.
The page words every reason code in one fixed sentence.

The walking test pins four exitless stops by name: `blocked.withoutWorker`,
`running.reviewerDeliveryLegacy`, `running.workerDeliveryLegacy` and `uncertain.legacy`. They stay
parked for Foreman inspection because the original worker identity or saved delivery key is absent.
No new recovery is implied. `running.reviewerCreation` exits through `retry-create`, described
below. Reviewer error and
approval incidents remain on `running`; only observed recovery of that reviewer clears them, not
`resume`. Provider waits retain their reset, continuation and pinned reviewer-fallback rules.
Serialized reconciliation sends queued notices to the owning Foreman through `host.send`, including
after adapter restart and while execution is paused. Failed or ambiguous sends remain queued for the
next reconciliation. A successful append with a lost acknowledgment can produce duplicate notices.
Successful delivery is recorded durably and does not repeat normally. Handoff readdresses the notice
to the new owner without changing its ID. The former owner cannot recover it. A stale ID cannot
resume a later checkpoint.
Status and HTTP reads neither drain notices nor change incident state. Notices contain no private
worker reasons, instructions, paths, or review findings; diagnosis uses the private saved evidence.

Provider usage limits use reason `provider-limit` and recovery `wait`. Connected owner observation
reads `agentError` only from `amp.get_thread_status` for the matching thread. Recognition requires
code `MODEL_PROVIDER_ERROR` and a JSON error with type `rate_limit_error` and a message string.
Assistant prose, bare reset text, malformed payloads and other errors remain `worker-error` with
their existing recovery (`resume` for a checkpointed worker, `inspect` for a reviewer). A connected
owner can reclassify a worker error recorded earlier without provider details, restoring its saved
checkpoint without replacing the worker or advancing attempts. Restoration waits until no other
active or uncertain work holds the same lane; otherwise the stop remains for the Foreman.

The incident privately stores `providerLimit.message` (the raw provider message), `observedAt`,
the same worker or reviewer `thread`, and optional `resetAt`, in milliseconds since the Unix epoch.
Recognized reset text is `resets H[:MM]am (UTC)` or `resets H[:MM]pm (UTC)`.
The hour must be 1 through 12.
With no date, choose the next occurrence only if it is within five hours plus five minutes of
observation. Otherwise choose the previous occurrence and treat the reset as already due. This
bounds the known five-hour usage window with a small clock margin, since first observation can
happen after reset and Amp leaves the error in place. For example, `resets 7pm (UTC)` observed at
17:19, 19:11 or 20:19 UTC means 19:00 that day, not tomorrow.
Unknown formats and zones retain the limit with no parsed reset.
Repeated observations retain the original instant rather than moving the deadline forward.

Once the reset passes, any connected owner lifecycle reconciliation reserves one continuation in
SQLite before appending it to the same thread. Observed running or idle activity also permits
continuation before a stored reset. Without a parsed reset, 30 minutes since observation is due.
Execution must remain enabled and permitted. Pausing prevents continuations. No `agent.start` hook
is required for this path. `providerLimit.continuation` records its time and `sending`, `sent`, or
`unknown` outcome. A crash or lost acknowledgment leaves the reservation held, never retried.
Inspect an uncertain delivery before manual recovery. Only a wait without a continuation is exempt
from ordinary stall nudges and spending alerts. A held continuation that does not recover becomes
an ordinary stall. Other incidents retain their existing diagnosis path. A provider error observed
after a confirmed sent continuation starts a new incident only if its provider message differs or
its parsed reset is later than the continuation. Advancing the local observation clock alone is
not evidence of a new error. Identical errors retain the incident, send no further continuation or
stop notice, and receive ordinary stall monitoring. Sending and unknown remain held. Observed
running or idle activity after any reservation clears the incident even without connected tools,
so subscription wakes can settle reports and verdicts. A later error then opens a new incident.
Other errors and approval requests follow their existing stop path, not a provider-recovery event.

When stall checks and automations do not need earlier wakes, the owned watchdog targets the
earliest pending reset plus one minute, using a UTC `DTSTART` and the existing 30-minute RRULE.
With no parsed reset, it targets observation plus 31 minutes. The next connected reconciliation
after the deadline restores the ordinary rule. Registration still inspects receipts, rejects
drift in recurrence, run mode or enabled state, and preserves unrelated schedules.
An unapplied anchor change is retried on the next read, not mistaken for configuration drift.
`monitor.wakeAt` records only the confirmed anchor, separately from the pending schedule effect.
UTC and TZID anchors are compared at the requested instant, including daylight-saving offsets.
The Foreman receives the reset-aligned wake in its existing thread. Waiting workers and reviewers
receive one continuation per incident.
Whether the Foreman's `agent.start` handler runs when its own model call fails on a provider limit
remains unproven. If no connected owner observes a limit, only the ordinary watchdog remains.
Fixtures prove these decisions, not a live limit, sleeping-orb wake, or successful model recovery.
Those live proofs remain with the Foreman. The default policy performs no model or provider switch.

### Retained evidence

Evidence is recorded where each fact happens. Every completed gate run saves the candidate report
it checked and its full output: the final run with its `gate-returned` transition (`gate`, or
`gate-rerun` after a flake rerun), and a failed run before its rerun on its own. A review verdict
is saved with its `review-verdict` event. So a rebase, rejection or block keeps the evidence for
the revision it replaced. Each SQLite `evidence` row holds ticket, attempt, kind, 40-character
revision, pinned definition digest (null for legacy unpinned runs), producing tool (check command,
reviewer model or worker model), closed outcome, SHA-256, byte count and time. Content is written
first to `factory/evidence/<sha256>` beside the database and verified by digest before the row
commits; if that write fails, the transition fails with it and the gate reruns on the next
reconcile. Worker reports, logs and removed worktrees can be deleted afterward. Repeats converge on
one row. The same identity with a different definition or tool is refused with its transition.
Invalid kinds, outcomes, revisions or tools are refused before anything is written.

Before any merge or ledger entry, acceptance reads only persisted, intact records bound to the exact
attempt and revision being landed: the candidate report whose digest matches the report it accepts,
a `gate-passed` record and, when the run was reviewed, a `pass` review record. Records for earlier
attempts or other revisions are stale and never count. Missing, corrupt or stale proof stops the run
as `blocked` with reason `evidence-missing` and recovery `inspect`; the Foreman exits through
`record-landing`. Tickets accepted before this record existed keep their done state unchanged; a
review already in flight at upgrade has no gate record and stops this way rather than landing.
The owner reads private content with `evidenceContent(directory, ticket, sha256)`, which refuses
digests the ticket never recorded and missing or corrupt files. Private backup preserves recorded
evidence by digest, not the original report or log paths.

### Phase lessons

At phase completion, the owning Foreman can call `record-lesson` with a `lesson` object:

- `ticket`, `phase`, `sourceThread`, `revision`, and `attempt` identify the source. The source
  thread must belong to the ticket. SQLite supplies the project identity.
- `scope` names affected repository-relative paths. End directory paths in `/`.
- `evidence` lists one to four retained SHA-256 digests from that ticket, attempt, and revision.
  The factory checks the bytes and requires a passing gate digest for `findings`.
- `findings`, `failedApproaches`, and `questions` take up to two single-line entries each, with
  at least one entry across the three lists. The Foreman checks that each finding follows from
  the cited proof. Never submit credentials, logs, or transcripts. Input checks reject oversized
  or multiline summaries and transcript markers. Credential checks also cover labels and paths.

The same phase and source revision can be recorded again with identical content, but not changed
in place. To correct a finding, record a new revision with the same ticket, phase, and scope. Set
`supersedes` to the old lesson ID. `list-lessons` with `ticket` shows both sources to the owning
Foreman. Neither action accepts a ticket or releases its dependents.

The worker handoff includes at most three current, intact lessons from direct dependencies or
matching paths. To opt into path matching, set `lessonScope` on the authored ticket row. The
factory pins those paths when it creates the worker. The paths do not grant edit permissions.
An enabled factory reconciles still-undelivered findings for affected workers in the build stage.
The factory reserves them before calling Amp. It reports an unknown standalone send and does not
retry it. After Amp confirms a handoff was absent, the one allowed retry includes newly applicable
findings and excludes superseded ones. If the handoff arrived, the factory sends only the missed
findings separately. Saved delivery intents never appear in plugin state replies. Supersession
cannot retract a message the worker received. Failed approaches and questions stay in private
history.

### Lifecycle stages

`runStage` in `persistence.ts` names every ticket's stage and who must act. Status, the dashboard
feed and stop notices all read it; nothing else maps run kinds to stages. Run kinds are unchanged.

| Stage          | Meaning                                           | Default actor |
| -------------- | ------------------------------------------------- | ------------- |
| `queued`       | Waiting for dispatch                              | computer      |
| `planned`      | Waiting for Foreman admission                     | foreman       |
| `preparing`    | Setup runs in the worktree                        | computer      |
| `creating`     | The worker thread is being created                | computer      |
| `building`     | The worker is writing or repairing                | model         |
| `gating`       | The pinned gate is running                        | computer      |
| `reviewing`    | Cold review is in progress                        | model         |
| `escalated`    | Two rejections; Foreman diagnosis                 | foreman       |
| `parked`       | Attempt cap reached; operator decision            | operator      |
| `rate-limited` | Waiting for a provider limit to clear             | computer      |
| `disconnected` | Suspected stall on the same worker or reviewer    | operator      |
| `blocked`      | Any other stop                                    | foreman       |
| `uncertain`    | An unknown delivery outcome                       | foreman       |
| `accepted`     | Accepted locally; merge not recorded              | foreman       |
| `merged`       | `record-merge` or `record-landing` stored a merge | nobody        |

A stop on any stage names its actor from the matching stop in the transition table, so an
interrupted setup stays `preparing` but waits on the Foreman.

Each fact is recorded where it happens. When the gate command spawns, `checkCandidate` saves `gate:
{ at, pid, deadline }` with its detached process group and event `gate-started`; the command waits
until that save succeeds. The marker is removed with `gate-returned` and the outcome as soon as the
gate returns. Reconciles hold the store lock, so a marker found when a reconcile starts belongs to
an earlier coordinator. While its process group is alive (or cannot be probed) the run stays
`gating` and no reconcile settles it or starts another gate. The gate's timer dies with its
coordinator, for example in an Amp CLI restart. The marker also saves `start`, the boot ID and the
leader's start tick. `deadline` is `at` plus the running command's own timeout: each check saves its
own marker when it spawns, and a flat `verify` saves 600 000 ms. A reconcile past `deadline`, or
past `at` plus 600 000 ms for a marker saved before `deadline` existed, kills the group with
SIGKILL, records `killed` and event `gate-killed`, but only while that same leader is alive. A
reused PID is never killed; a marker from another boot is retired without killing, and one whose
leader is gone or that has no `start` stays `gating`. Once the group has stopped, the next reconcile
removes the marker with `gate-interrupted` before the paused or permission check, so a paused
factory stops reporting `gating` without running anything. If the idle worker's report is still a
clean candidate, the normal path gates it again once; otherwise the run is rejected or stopped as
usual and never reads `gating`. A gate has no effect outside its worktree. The `status` action reads
the committed snapshot without queueing behind a running reconcile, so it reports `gating` while a
gate runs. Each commit stamps `stageAt` on every run whose stage changed. `reject` records
`rejectedBy` as `report`, `gate`, `review` or `merge` (a rebase conflict), and acceptance records
`acceptedAt`. Runs saved before these fields open unchanged and read `stageAt` as unknown.

### Provider limit policy

The optional definition setting `providerLimit` selects `mode: wait` or `mode: fallback`. Omission
and `{ "mode": "wait" }` preserve the wait and continuation behavior above. The policy is pinned
when a run starts. Reload changes future runs, not active reviews or repairs.

For an OpenAI worker, an explicit reviewer fallback can be configured as follows.

```yaml
providerLimit:
  mode: fallback
  reviewerModel: xai/grok-5
```

`fallback` requires a `reviewerModel` in `provider/model` format with a known family opposite to
the implementation worker's family, even when review is disabled. Known first-party namespaces are
`alibaba`, `anthropic`, `deepseek`, `meta`, `minimax`, `moonshotai`, `openai`, `thinkingmachines`,
`xai` and `zhipuai`. Hosted and routed namespaces such as `amp`, `openrouter`, `baseten`,
`fireworks-ai`, `google-vertex`, `nvidia` and `ollama-cloud` do not prove family independence and
are refused for the implementation worker and fallback reviewer. The fallback must differ from
the default reviewer model. A different model inside the default reviewer's own family is allowed,
but only helps with a model-specific limit, not a provider-wide limit. Invalid modes, unknown
fields, missing models, unknown families, same-worker-family fallbacks and the identical default
reviewer fail before dispatch and on stored-pin reads.

When a reviewer hits a provider limit, fallback creates one fresh cold reviewer on the named model
at high effort, on the same executor, for the same ticket, attempt, staged revision and base.
The replacement receives the original cold review contract, not the limited reviewer's opinions.
It writes a separate verdict path, so a late verdict from the original reviewer cannot approve
the candidate. If the fallback is also limited, it waits. There is no fallback chain.
Creation intent is durable before the call. Unknown creation is held for inspection without a
second creation, and unknown delivery follows the existing exact-message recovery path.

The private review record's `model` identifies the reviewer actually used. Its `fallback` object
records the original `model`, original `thread`, and provider-limit `reason`. The
`review-fallback-creating` and `review-created` events retain this substitution, including failed
or ambiguous creation. Acceptance retains the review record and actual `workerModel`.
Old runs without model fields still load without inventing historical model use.

Fallback also accepts an optional `workerModel` in `provider/model` format. The installed
`@ampcode/plugin` API exposes thread creation and message append, but no model-change operation for
an existing thread. Workers therefore wait even when `workerModel` is configured. The factory
never replaces a worker, changes the Foreman's model, selects providers automatically, or routes
by cost.

### Progress watchdog

Serialized lifecycle reconciliation also checks a progress watchdog. The optional definition setting
`watchdog` contains positive safe integers `suspicionMs` (default 1800000), `spendingFirstAttempt`
(default 6), and `spendingInterval` (default 4). All three are required when the setting is
supplied. `disconnectMs` is optional and defaults to 180000, including for older pins.
Policy is pinned with each run; older definition pins use these defaults. No separate configuration
file is needed.

Each run stores a watchdog episode, attempt, meaningful progress time, last nudge reservation, and
alert intents. Stops bind their episode to the stop incident. Foreman reassignment and notice
delivery do not restart its clock. Worker dispatch, repair, review milestones, acceptance and new
stops advance progress. Diagnostics, errors, observation refreshes, notices, nudges and other
tickets do not.
Legacy runs without timing start their clock once on enabled reconciliation, without guessing age
from arbitrary old events. Existing SQLite versions still open without a schema migration.

At the first unresolved 30-minute boundary, reconciliation persists one user-alert intent for that
episode and reserves a Foreman diagnosis nudge before sending it. Another nudge requires a full
interval since the last reservation, even after a restart or ambiguous send. A crash between
reservation and send can lose that nudge. The next interval permits another. Running and unknown
worker activity retain ownership, never dispatch a duplicate or replacement, and are not proof of
a hang or acceptance.
Attempts six, ten, fourteen and so on independently record non-blocking spending alerts without
parking safe work or resetting the progress clock. Repairs beyond the cap require owner resumption.
Parking reserves its alert at rejection, not from the spending count or suspicion clock.
Parked runs do not generate timed suspicion nudges or further alert intents until resumed.

#### Observer thread

The connected owner can call `register-observer` once. It creates one observer thread with model
`anthropic/claude-haiku-5-5` at high effort (or the definition's `observer`) through the same
thread-creation path workers use, and records the thread, model, effort and time in the Foreman
records. The watchdog schedule then targets the observer with a short prompt, and suspicion
nudges go to it instead of the owner. The owner's own schedule is cleared only after the
observer's registration is confirmed. Every connected owner reconcile repeats that cleanup by
read-back, so a failed or interrupted clear is retried and `monitor.problem` stays until the
clear is confirmed. Pause clears both.

The observer may call only `reconcile`, `status-summary` and the checked `message-foreman`
delivery; the one caller check refuses every other control action before any state change.
Its reconcile has no connected tools, so it never
changes schedules or sends user alerts; the owner's connected turns still do. `status-summary`
returns per-run ticket, kind, lane, attempt, stage, last progress time from the lifecycle stage,
incident ID and reason, and review delivery. Its `due` list names the owner-only work a connected
owner reconcile would do now, each with a stable ID: a provider continuation past its reset
(`<incident>:continuation-due`) and each alert intent not yet reserved. A held sending or unknown
alert reservation is not due, and no alert is due while the rolling hourly notification budget is
spent. An alert's due ID includes the latest reservation time, so an alert left over when the
budget ran out is escalated again once capacity returns. It has no briefs, report paths,
worktrees or thread content, and the observer's `reconcile` replies with the same summary instead
of full state. The observer messages the owner only for a new incident ID, a higher attempt (a
rejection or a resume), a run newly done (accepted), a suspicion nudge, or a due ID it has not
reported before, so each due ID is reported once. Any other kind or stage change, such as building
to reviewing, is routine progress, and the observer ends its turn silently.

`remove-observer` clears the observer's schedule, confirms the clear by read-back, and moves wakes
and nudges back to the owner. The removed thread is recorded as retired, and the caller check
refuses it every action, even after a replacement observer registers. Saved state without an
observer opens unchanged and keeps waking
the owner as before.

Alert IDs, kind, episode, attempt, intent time and optional `acknowledgedAt` survive reload and
repair. Connected owner reconciliation delivers these intents through `amp.notify_user`. It
reserves each ID in SQLite before sending and acknowledges only a successful tool result. Sending
or unknown reservations remain held across reload. The installed API exposes no notification
receipt lookup, so an ambiguous send is not automatically retried. Inspect the actual delivery
with the owner before deciding any manual recovery. A new bounded diagnosis nudge is not a retry
of an uncertain alert. Nudge delivery also requires a connected owner context.

The factory reserves at most ten notification attempts in a rolling hour on its owning thread,
including ambiguous attempts. Amp independently enforces its thread-wide ten-per-hour limit,
including unrelated notifications. A platform rejection stays unknown rather than spending more
attempts on blind retries. Deferred unsent intents are eligible on the next connected
reconciliation.
Only curated ticket ID, attempt, alert kind and episode appear in push/email text, never private
briefs, observed thread titles or failure reports.

Authorized `start` installs one existing-thread watchdog before dispatch. It wakes every minute
while eligible work can start or a run needs stall checks. Otherwise it wakes every 30 minutes,
or sooner if an enabled automation needs it. The 30-minute suspicion threshold is unchanged. The
stable SHA-256 fingerprint binds the software factory identity, root and Git storage directory.
Ownership uses the fingerprint in the title or prompt, not the prompt wording or echoed settings.
Repeated start accepts its owned, enabled registration. The factory retimes a known minutely rule
in place by its owned schedule ID and confirms it by read-back. An unsupported recurrence, run
mode or enabled state is drifted, not foreign: it stays safe to clear, but is not reported as
installed. Inspect those settings before further execution; pause can clear it before a new start.
An unrelated schedule or second root is never replaced; start visibly refuses monitored execution.
Other owner actions report the registration problem without blocking incident recovery. When
paused or finished, a foreign schedule means our watchdog is absent, not a conflict. Installation
failure parks start disabled, leaves a first-time owner unset and must not
be reported as monitored execution. Schedule reads, writes and SQLite commits are
separate effects. Every create or clear is followed by inspection, even after a lost acknowledgment.
If inspection is unavailable, status records `monitor.schedule=unknown`; the next connected
reconciliation inspects before taking any remote action. `monitor.problem` explains the failure.
Reconcile, retry-setup, exact-incident resume and pause continue under their normal gates, including
queued stop-notice delivery, but withhold watchdog nudges, alerts and further schedule effects for
that turn. A registration failure alone does not pause dispatch. SQLite failures still abort.
Only the initial, pre-dispatch start admission can refuse execution for unconfirmed monitoring.
An inspection failure while flushing after dispatch records `watchdog-unconfirmed`; it does not
disable the factory, label the completed start as failed or authorize clearing a live watchdog.
A pending effect records its thread even before the first owner claim: return to that thread to
inspect via start, or pause there to clear.
Do not switch threads while that effect is uncertain. A refused start with no pending effect leaves
another schedule-free thread eligible to start.

Connected owner `reload`, `reconcile` and owner turn startup recover a missing registration.
Intentional pause and completed queues clear only the matching watchdog. Context-free plugin
callbacks cannot install schedules or deliver alerts. A reload without a connected owner must wait
for that owner's next turn to restore monitoring. Automatic plugin-load recovery defers while an
enabled factory lacks confirmed registration, including legacy state without monitor metadata.
That guard applies only to automatic plugin-load recovery: explicit tool-less reconciles and
subscription callbacks still settle and dispatch under their normal gates without watchdog effects.
Runner creation still returns control before creating the thread. Its deferred continuation cannot
use the finished tool context for status or watchdog calls; the next connected owner turn performs
those effects. This does not change creation deferral or the exact-incident `retry-create` path.
No keepAlive lease, global scheduler or hosted
monitor is installed. Legacy SQLite opens unchanged; monitor metadata is added transactionally on
the first connected lifecycle effect without changing existing definition pins or incident IDs.

Pause persists the local stop before inspecting or clearing any remote schedule. Non-worker,
non-reviewer threads other than former Foremen can pause, reconcile or reload without schedule or
alert effects. The owning Foreman's next connected turn clears its watchdog after such a pause.
This local stop remains available if the owner cannot start. Only the connected owner can start
monitored execution or resume a repair. A changed root/Git path after copy or restore records a
durable fingerprint conflict, not an installed monitor. Pause still persists even if its tool result
reports that conflict. Restore the original root and Git storage paths before connected recovery.
Automatic fingerprint migration to a new path is unsupported. Inspect the old thread's schedule.
Seek an explicit adoption decision. Do not edit the fingerprint or clear an unrelated schedule.

**Unsupported coverage boundary.** An unstartable Foreman cannot independently notify its owner
through this plugin. A platform outage or failure before the connected owner can run its tools is
not covered. No independent platform failure notification was observed or is promised. Sleeping-orb
wake and real push/email delivery remain pending for the Foreman after acceptance. Controlled
adapter tests do not prove those live criteria.

The worker inspected `node_modules/@ampcode/plugin/index.d.ts`. `PluginTools.call(name, input)`
returns `Promise<unknown>`, requires a connected thread, applies normal permissions and
confirmations, rejects execution failures and never retries after a lost connection. `agent.start`
provides the active thread ID and connected tools. Read-only CLI capability inspection returned
`No such tool` for `amp.get_schedule`, `get_schedule` and `notify_user` in this worker environment.
This is not evidence about the connected Foreman's web tools. The worker performed no live
schedule or notification calls.

**Foreman-observed contract, 2026-11-14.** The Foreman inspected and exercised these tools through
`code_exec`, not the plugin `tools.call` bridge:

- `notify_user` requires `title` (at most 100 characters) and `body` (at most 300 characters).
  There is no `message` input. This was signature inspection, not proof of real alert delivery.
- `get_schedule` returns `null` when no schedule exists.
- `set_schedule` with the 30-minute RRULE and `run_mode: "existing"`, followed by `get_schedule`,
  returned an object containing `id`, `title`, `targetThreadID`, `prompt`, `enabled: true`,
  `runMode: "existing"` and `trigger`. The trigger contained `provider: "schedule"`,
  `scheduleLabel: "Every 30 minutes"` and this schedule value:

  ```text
  DTSTART:20261114T143900Z
  RRULE:FREQ=MINUTELY;INTERVAL=30
  ```

  The object also contained `agentMode`, `reasoningEffort`, `disabledReason`, `nextRunAt`,
  `lastRunAt`, `lastRunError`, `createdAt` and `updatedAt`. There were no top-level `schedule`
  or `run_mode` fields. Compare the parsed RRULE frequency and interval in `trigger.schedule`,
  `runMode` and `enabled`. Ignore unknown metadata and, for the ordinary rule, a platform anchor
  whose start is not in the future. A start still ahead delays every wake, confirmed or not, and
  is an unapplied change to retry, not configuration drift. For a provider-reset wake, also
  confirm the requested anchor by instant, accepting UTC or TZID normalization, with the same
  retry rule when it is missing. Fingerprint alone determines ownership, even when those settings
  drift.

- `clear_schedule` returned `{"deleted":true}`; the next `get_schedule` returned `null`.

**Foreman-observed cross-thread contract, 2026-11-16 at about 03:25 UTC.** The connected Foreman
inspected tool signatures and made read-only calls from
`T-01a1d839-1f2a-7163-aca7-ff36ee2ba954`. `get_schedule`, `set_schedule`, `update_schedule`, and
`clear_schedule` each accept an optional `{thread: "T-..."}` target instead of the caller. The
current hosted API allows several schedules: `set_schedule` adds one, `get_schedule` can return
a list, and `clear_schedule` can take a schedule ID. The factory only manages a uniquely
identified watchdog and updates its cadence by ID rather than creating a second registration.

`get_schedule({thread: "T-01a1e1de-5d05-7143-8002-040650c600c4"})` returned null for an archived
worker without a schedule. Targeting the Foreman returned the full record with ID
`71cd8841-c79d-54a2-9d84-83580b36c81f`, the matching `targetThreadID`, title
`Factory watchdog 89f80aca...`, `enabled`, `nextRunAt`, and `prompt`. These replies establish the
targeted-read shape. The fixture copies the optional target and rejects a second create on a
thread. It checks the factory's single-watchdog invariant, not hosted add/list behavior.
Cross-thread clear and plugin bridge wrapping have not been observed live. The Foreman's live
takeover proof must exercise a fingerprinted old registration and confirm the clear by read-back;
a paused transfer with two empty schedules cannot prove cross-thread clearing.

Plugin bridge result wrapping remains unobserved. The adapter accepts parsed objects and JSON
strings; other shapes leave monitoring unconfirmed without replacing a schedule. Controlled
fixtures reproduce this observed contract and reject invalid notification input. They do not prove
sleeping-orb wake, plugin bridge wrapping or actual push/email delivery.

Explicitly paused factories, completed runs and planned/dependency-only work produce no watchdog
progress nudges or alerts. Handoff cleanup warnings use the separate policy above.
Status, heartbeat publishing and HTTP reads remain read-only and do not deliver messages.

Coordinator status reads existing SQLite or validated legacy state without creating runtime files,
initializing the lock store, or migrating. The plugin separately refreshes dashboard observations,
independently of status calls. Malformed legacy records, corrupt databases, and unsupported schema
versions fail visibly before dispatch. Initialization does not grant execution permission.

## Back up private coordinator state

Configure an existing private GitHub repository in the project definition with
`"backup": { "repository": "owner/name", "projectKey": "stable-key" }` and explicitly grant
`"backup": true` inside `permissions`. This permission does not grant worker execution or
application publishing. Authenticate Git and `gh` through your existing credential mechanism.
Do not put tokens in configuration or repository URLs. The destination must have a default branch
with an initial commit. Setup does not provision it or grant backup permission.

Run `bun factory/backup.ts /local/project/root`, or invoke the registered factory control tool with
`action: "backup"`. For an explicitly authorized phase checkpoint, the owning Foreman calls the
same tool with `action: "backup"` and the `lessonID` returned by `record-lesson`. Recording a lesson
does not publish on its own. An unknown lesson or missing required evidence blocks the checkpoint.
Both paths call the same backend. The command accepts no destination overrides.
Metadata must identify the configured repository as private on GitHub.com before publication
proceeds, with explicit `PRIVATE` visibility. Enterprise-internal repositories are refused.
Both the metadata lookup and publication target GitHub.com, regardless of `GH_HOST`.

Commits and rebases use the identity Git resolves in the retained backup workspace, including
identity environment variables. If Git cannot resolve an identity, the command falls back to
`Factory backup <factory@localhost>` for that invocation. It never writes Git configuration or
disables signing. If signing requires a particular identity, configure that identity through your
existing Git settings. A refused commit reports `Backup commit was refused; inspect commit identity
and signing configuration`, retains the last confirmed receipt, and leaves generated files staged
for inspection. Fix the identity or signing configuration and retry. Raw Git diagnostics stay
hidden.

Only three files under `projects/<projectKey>/` are staged:

- `state.sqlite` contains the consistent coordinator state, including lessons and their history.
- `evidence.json` maps recorded SHA-256 digests to the exact evidence bytes encoded as base64.
  Backup reads only the digests named by the captured SQLite rows and verifies their size and hash.
  A missing or corrupt evidence file refuses publication.
- `manifest.json` records the manifest and schema versions, stable project key, application
  revision, evidence and lesson identities with source revisions, and both payload hashes.

SQLite `VACUUM INTO` captures a consistent snapshot, then `integrity_check` validates it. Both run
outside the plugin process in the installed `bun` executable. The operation supports rollback
journals and WAL without changing settings. Rollback mode can contend with concurrent writers.
Before staging, backup checks each text field in the frozen database and each evidence file for
recognized credential signatures. This cannot detect all secrets. Never record credentials in
coordinator state or evidence.
Configuration files, authentication files, unrelated files, and unrecorded evidence are not
collected. Nothing is written to the application Git history.

The Git directory contains `factory/backup/receipt.json` and a retained publication workspace.
The receipt records pending, confirmed, failed, or uncertain publication and preserves the last
confirmed remote revision, manifest SHA-256, application revision, and confirmation time. This
receipt covers that snapshot, not later local progress. Older receipts without a manifest hash do
not prove evidence coverage. Receipts stay outside SQLite so unchanged input produces no new commit.
A checkpoint whose lesson is already in the last remotely confirmed manifest returns that receipt
before capturing newer local progress, even if later evidence is missing. Use a manual backup to
preserve newer progress.

A filesystem lock rejects overlapping manual and checkpoint requests. After an interrupted process,
inspect its receipt and confirm no backup is running before removing `factory/backup/lock` and
retrying. Retry restores only the selected project's three generated paths to their committed
versions and regenerates them, so interrupted staging or a refused commit does not block recovery.

Pushes never force the branch. Confirmation fetches the remote and checks that it contains the
intended commit, including when a push response is lost. If confirmation is unavailable, the
receipt stays uncertain. Retry inspects the remote before another push. After a successful fetch,
a pending revision missing from a recreated workspace is not published on that branch.
Unpublished local backup commits rebase onto the fetched tip, preserving unrelated project changes.
A same-path conflict aborts the rebase and refuses publication without discarding either side.
Workspace changes outside the three generated paths fail without discarding files. Preserve the
workspace for inspection. Safety refusals identify the cause without exposing external diagnostics.

Raw report and log paths, worktrees, the poteto ledger, and dashboard observations are not included.
Tests use disposable local remotes, never GitHub writes.

### Restore on a replacement checkout

Before loading the factory plugin or running `--refresh`, check out the application with the
snapshot's application revision in its history. Keep the same `backup.repository`,
`backup.projectKey`, and `permissions.backup` in its definition. Run:

```sh
bun factory/setup-factory.ts --repo /local/project/root --restore
```

Restore reads the configured private repository's default branch. Its latest commit changing the
project's snapshot files must contain all three files and pass manifest, SQLite, and evidence
validation. Evidence and lesson source revisions must resolve to commits in the replacement
checkout, but need not be ancestors of its `HEAD`. Restore does not fall back to an older snapshot,
write to the remote, or replace existing files under the local Git directory's `factory/`. Use a
clean replacement checkout; keep existing state, legacy files, and journals for inspection.

The database, evidence and `restore-pending.json` hold appear together after validation. If the
process is interrupted before installation, a retry uses a fresh staging directory and ignores the
abandoned `factory-install-*` directory in Git metadata. These directories may contain private
data. If interruption occurs after installation, a retry refuses existing state.

The restored owner, workers, and pending actions remain unchanged. Status can inspect the snapshot,
but startup, dispatch and effect replay are held. A missing retained worktree is a recovery blocker,
not permission to start another worker. There is no release command in this ticket. Do not remove
the hold to start the factory; cross-orb ownership reconciliation is tracked in `v1-ticket8`.

Missing local state with a configured backup is an error at runtime, not an empty queue. For a
genuinely new project with an authored definition and no local state, use `--initialize` instead of
`--restore`, before `--refresh`. It creates stopped local state and never probes the backup remote.
Do not use it to recover an existing project. Existing installations without backup configuration
retain their legacy local startup behavior.

## Worker settings

Fresh setup defaults to `openai/gpt-6.2-sol` with `workerEffort: "medium"`. Choose a model with
`--worker-model` and effort with `--worker-effort`. Supported native Amp effort values are `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Invalid CLI effort fails before setup writes. Invalid saved effort blocks checks and dispatch
before worker creation.

Existing configuration without `workerEffort` keeps Amp's model default and is not rewritten.
Repeated setup and refresh preserve saved model, effort, permissions, tickets, and runtime state.
To change future workers, edit `workerModel` and `workerEffort` in the project definition,
then reload. These settings apply only when creating a new worker. Corrections continue with
the original settings, not a replacement.

Generated governed installations require one Sol 6.2 medium lane and native Astra 6.2 medium review.
Other worker settings and the optional second lane remain supported by the native engine, not by
this installed policy. Refresh preserves incompatible settings but refuses their execution; it
never rewrites permission or converts an existing worker to another model. Active immutable pins
must also match; unknown legacy worker pins refuse. Provider fallback remains native-only for this
policy, so a limit cannot silently substitute another implementor lane.

### Two worker lanes

A definition runs one lane by default: `capacity: 1` and no `lightWorker`, dispatching exactly as
before lanes existed. Set `capacity: 2` together with `lightWorker: { "model": "provider/model",
"effort": "high" }` to add a light lane; either without the other fails parsing. The light model
needs a known family, and with `review: true` a supported native default reviewer, like
`workerModel`. Setup accepts `--light-worker-model` and `--light-worker-effort` (default `high`).

Mark a queue entry `"lane": "light"` to run it on the light worker. Every other entry runs on the
main lane. `lane: "light"` fails the definition check unless the definition has a light lane.
Dispatch keeps at most one open run per lane. Each run saves its `lane` and the `workerModel` it
was created with, and review routing follows that saved model. Every unfinished run occupies its
lane, including a parked run and a worker blocked on approval, an error or its own report, so a
second ticket never starts or resumes beside a worker that could still continue. One check admits
dispatch, resume, provider-error restoration and retry-setup alike. A stop in one lane,
including an escalated repair or an unknown creation or delivery, holds only that lane. A single
lane keeps today's rule, where only active work and repairs hold dispatch. Factory-wide holds
still hold both: a paused or ownerless factory, a dirty root checkout, and `brief-incomplete`.
Saved runs without `lane` are main-lane runs. A light run never falls back to the main worker:
retry-setup refuses, leaving the saved preparation unchanged, once the definition drops
`lightWorker`. Gates still run one at a time through the test lock.

Landing order follows completion. When a candidate's target moved past its base, at acceptance or
before review starts, the factory waits for the worker to be idle, replays the candidate onto the
target in a disposable staging worktree, saves the source and replayed revisions in a
`rebase-intended` event, moves the worker worktree to the replayed revision, and records `rebased`
only once the worker's HEAD is verified there. A reconcile after an interruption finishes that move
before checking the candidate, then reruns the full gate on the replayed revision. Review, when
required, then covers that revision, and only it can land. The worker's report keeps naming the
revision it built. A replay conflict leaves the worker worktree unchanged and returns to the same
worker thread as repair feedback with the rebase log, counting as an attempt. A target that no
longer descends from the base, or a dirty root checkout, still stops at `target-changed`. With a
light lane, resuming a blocked repair also accepts a target that moved forward, and its next
candidate is rebased; a single lane still refuses it.

A reviewer whose target moved forward during review is not stopped. Its verdict for the reviewed
revision is read first: `issues` returns to the worker as repair feedback, and `pass` leads to the
rebase above, with a fresh gate and review. Only a rewritten target or a changed candidate or
staging worktree still stops at `review-identity-changed`.

### Run workers on a supervised runner

Set optional `workerRunner: "factory-dogfood"` in the project definition and reload to create
future worker and reviewer threads with `{ type: "runner", id: "factory-dogfood" }`. The setting
must be a nonblank string. It is pinned for the run, including review and same-worker repair.
Without it, new threads use `local`, which uses the Foreman's current client as executor.
Creation failure on the named runner remains visibly parked in `creating` with a creation-unknown
incident. The factory never falls back to `local` or starts, stops, or supervises runners.

Amp refuses to create a runner thread while a tool call of the plugin is in flight. A control call
that reaches such a creation therefore returns first, with the run still shown as `creating`, and
the creation continues once the call has returned. Call `status` again to read the result.

A parked `creating` run never retries by itself. After confirming that no thread was created, the
owning Foreman can call `retry-create` with `ticket`, the current `incident` ID and a nonempty
`decision`. This repeats that one creation in place, on the executor pinned for the run. A stale
incident ID, a missing decision, or a run in any other state is refused.

The same action recovers a reviewer creation interrupted on a `running` run, whose review delivery
is still `creating` with a creation-unknown incident. The lifecycle table declares this exit on
`running.reviewerCreation`, and only a running run held by that stop is admitted. After confirming
that no reviewer thread exists, the owning Foreman calls `retry-create` with the same fields. The
factory first checks that the staged worktree still holds exactly the saved revision, clean; a
changed or missing worktree is refused with no state change. It then records `create-retried` and
creates one reviewer for the saved review, which proceeds to delivery and a verdict as usual. The
run keeps its lane, attempt and worker. A running run whose review is sending or sent is refused.

For a post-landing reviewer whose full-gate proof became stale, the same owner decision clears the
creation incident without creating a reviewer. A scheduled reconcile must verify the exact landed
revision again before it can create a new reviewer. Dependents stay blocked until acceptance.

The installed plugin API exposes only `threads.get(id)`, not thread listing or search.
`CreateAgentThreadOptions` accepts a parent but no title, label, or initial message. Agent display
labels are not verified searchable keys. Although the Foreman's `find_thread` can list children,
its search index freshness and availability through the plugin are unverified. Creation therefore
stays parked for workers and reviewers. The factory does not infer absence from titles, keyword
hits, elapsed time, or assistant prose, and does not ask the Foreman to perform automatic lookups.

The operator can supervise the runner from the factory repository root with:

```sh
amp orb service start factory-runner --command 'amp --no-tui --runner-id factory-dogfood'
```

New run and review records include `executor` in SQLite and factory control status. Historical
records without that field mean `local`; opening them does not rewrite them or move their threads.
The Foreman observed a runner-created test thread execute commands again after the runner service
restarted. Tool continuity across a Foreman CLI or mid-turn runner restart remains unproven live.
Fixture hosts test the plugin request and durable records without creating real threads or
running a real runner.

### Recover unclear assignment delivery

New worker briefs, same-worker corrections, and reviewer briefs persist a `deliveryIntent` before
sending. Its deterministic SHA-256 key binds the factory directory, owner, ticket, attempt, role,
delivery purpose, and exact message. The outbound user message starts with `factory-key: <key>`.
The saved message and one-repeat reservation survive reload. Legacy records open unchanged;
uncertain deliveries without a saved intent still require manual inspection.

Enabled reconciliation with execution permission reads the target thread using the supported
`PluginThread.messages({ full: true, from: "start", offset, limit: 20 })` API. It reads through the
end of the transcript, including compacted history. Exactly one matching user message confirms
delivery without another send. A complete read with no match permits one repeat of the saved
message, reserved in SQLite before sending. An uncertain repeat is never repeated again, but a
later matching read can confirm it. `delivery-recovered` records the key, target and deciding
evidence; `delivery-repeat-reserved` records the absence that authorized the repeat.

Failed or unavailable reads, multiple matches, altered messages containing the key, duplicate page
IDs, and histories reaching the 2,000-message scan cap remain inconclusive. The original incident
and inspect recovery remain held. Increase the scan cap only with bounded pagination coverage.
Pause, disabled execution, and status reads never perform delivery recovery. Delivery confirmation
does not accept a candidate or replace a worker or reviewer. Provider-limit continuations, alerts,
and Foreman notices keep their existing delivery rules. Fixtures prove these decisions, not live
plugin transcript freshness or end-to-end remote recovery.

## Prepare worker worktrees

Preparation is opt-in. Set `setup` to a shell command in the project definition, or pass
`--setup 'bun install --frozen-lockfile'` during initial installation. Set `setupTimeoutMs` or pass
`--setup-timeout-ms 120000` to choose a timeout. The default is 120,000 milliseconds. Timeouts must
be positive integers no greater than 2,147,483,647 and require a setup command. Omitted setup keeps
the existing dispatch behavior. Repeated installation, checks, and refresh preserve saved settings.

The dispatcher records `preparing`, creates the worker worktree, and runs setup with that exact
worktree as its working directory. No implementation thread is created or messaged until setup
exits successfully and leaves the worktree clean at its base revision. Ignored dependency output
such as `node_modules/` is allowed; tracked edits and unignored files fail preparation with their
paths in the reason. An existing path must be the exact registered worker worktree before setup
can run. A path that fails this identity check is left intact for operator inspection rather than
treated as prepared. Commands run under the existing coordinator lock, outside SQLite transactions.
The coordinator records the command, timeout, worktree, log path, and process group in SQLite.
Setup and verification commands run through `bash -lc` with stdin connected to `/dev/null`.
They cannot prompt for input. The launcher removes inherited `SSH_CLIENT` and `SSH2_CLIENT` markers.
Together with replacing Bun's socket-backed stdin, this prevents Bash's remote-shell startup
detection from loading `.bashrc` and replacing dependency paths in nested shells.
Setup keeps a private readiness pipe until its process group is durably recorded; only then
does the launcher replace stdin and execute the declared command. Commands need no stdin redirection
in configuration. Login-shell profiles still apply; this is not a hermetic environment.
Logs live in the repository Git directory under `factory/<ticket>-setup-<unique-id>.log`. Output
is bounded and recorded as it arrives. A timeout or output limit kills the command's process group
and closes its output pipes so detached descendants cannot hold the coordinator open. Descendants
that escaped the group may survive; inspect and stop them before retrying.

A nonzero exit, timeout, or local preparation error records `preparation-failed` with its reason
and retained log. Preparation does not create an implementation attempt or spend a repair attempt.
Failed and interrupted preparation block further dispatch. Status, reload, start, and reconcile do
not repeat setup or create a replacement worker. Existing dashboards show failed setup as blocked,
with no worker thread.

To recover, inspect the saved reason and log, fix the environment or saved setup command, then call
the native factory control tool with `action: "retry-setup"`. Execution must remain enabled and
permitted. Commit any root checkout changes, including edits to the tracked definition, before
retrying. A dirty root is rejected before setup or worker creation. Retry uses the current
configured command and timeout in the same worktree. If the clean root has advanced, retry
fast-forwards the unowned preparation worktree to root HEAD and records that new base before running
setup. Local worktree changes or a non-fast-forward history require operator reconciliation; retry
never resets or discards them. Each retry retains the earlier logs and events. Setup commands must
tolerate partial prior execution, leave the revision unchanged and the worktree clean, and finish
their subprocesses rather than launch background services.

An interrupted command's recorded process group must have exited before retry can run. If the
coordinator exits during setup, inspect any surviving process before stopping it or retrying. A
reopened coordinator never assumes an interrupted command succeeded. A command observed closing
clears its saved process group, so a later retry does not mistake a reused PID for live setup. Once
preparation succeeds, worker creation starts at implementation attempt one. Ambiguous creation
and inconclusive delivery remain parked and cannot be retried with `retry-setup`.

## Conditional post-graft review

Review is opt-in: pass `--review` during initial setup or set `review: true` in the project
definition and reload for future runs.
Missing or false preserves gate-only acceptance. Refresh never enables review or rewrites saved
configuration. Invalid review, ticket size, or risk values fail parsing.

Tickets may declare `size: "small" | "medium" | "large"` and boolean `risky`. With review enabled,
only a small, low-risk first attempt skips review. Medium, large, unrated, risky, and retried work
requires one cold post-graft review, never a pre-graft review or a model call to classify risk.
The default reviewer runs cold on `openai/gpt-6.2-astra` at medium effort for OpenAI, Anthropic
and Moonshot AI workers. Independence comes from a separate cold thread reviewing the staged
artifact, not from requiring an opposite model family. Explicit provider-limit fallback settings
remain supported by the native engine; this default is not an OpenAI-only provider restriction.
A worker from any other family is refused.

Scope and risk are separate, following create-linear-ticket's Effort and Risk distinction. Small is
bounded with local effects; medium spans cooperating components; large changes cross-cutting
behavior or lifecycle. These describe scope, not elapsed time. In the ticket brief, record affected
consumers, shared state/contracts, and the safety fact verification must prove. Security, data loss,
shared persistence, concurrency/recovery, and integration ownership can make even a small change
risky. Following pstack blast-radius guidance, exercise that safety fact in real code rather than
treating a plausible writeup as proof. For example, this review lifecycle is large and risky:
dispatcher, persistence, and adapter share ownership, and recovery must never duplicate a judge or
accept unbound evidence. The live dogfood successor must retain that assessment in its own scope.

After the complete configured gate passes, the integrator grafts a required-review candidate into
an isolated staging branch/worktree. A fast-forward retains its genuine SHA. The canonical checkout
and dependents wait for a validated verdict bound to ticket, attempt, revision, base, and post-graft
stage. OpenAI implementation workers get Fable 5.2/high; Anthropic workers get GPT-6 Astra/high.
Unsupported providers fail visibly. The implementation worker's saved provider determines routing,
not the coordinator's model or subsequently edited worker settings.

The reviewer receives original requirements, staged code/callers, and coordinator gate evidence,
never worker messages, insights, self-review, or prior reviewer opinions. It loads `ce-code-review`
in `mode:agent` and uses its defect-finding method within the factory's read-only, non-delegating
contract. The factory's rules and JSON verdict override the skill's delegation, fixes, artifact
writes and report format. The reviewer uses shell and Read to locate the versioned skill in
`~/.cache/amp/global-skills/ampcode.com/user/`, falling back to the entry under
`~/.cache/amp/global-skill-manifests/ampcode.com/user/`. If SKILL.md cannot load, the reviewer
continues without it and adds no finding for the failure. A clean candidate still receives
`kind: "pass"` with `findings: []`. If references are absent, the reviewer uses SKILL.md alone
without guessing their contents. Installing or downloading skill files is not part of review.
Worker process lines in the requirements are not reviewer instructions.
Its only permitted write is its JSON verdict report. Findings require severity, location,
concrete evidence, and an actionable correction; empty findings can pass. Narrative text and idle
state cannot approve a candidate.

Review identity, delivery, verdict evidence, and events live in the existing SQLite run state.
The dashboard's existing title, thread, revision, and activity fields project the pending review.
Reloads reattach reviewers without replacements. Unknown creation or inconclusive delivery stays
parked for operator reconciliation; missing, invalid, blocked, stale, or unavailable verdicts cannot
land or consume corrections. Issues return to the original worker, with Foreman escalation after
the second rejection and operator parking at attempt four or later. Owner-only `resume` records
the next repair decision, with authenticated human confirmation at or above the cap.
A gate rejection sends the worker the exit status, marked stdout and stderr tails of at most 8,192
bytes combined cut on line boundaries, and the full log path, or names the precondition that
prevented the run.

A nonzero gate exit gets one rerun in the same worktree, only while the candidate HEAD and clean
tree still match. Precondition failures, a timeout, and execution errors reject without
a rerun. Logs remain at `<ticket>-<attempt>.log` and `<ticket>-<attempt>.rerun.log`. A second-run
pass continues to cold review under the existing policy without spending a repair attempt. The
`gate-flaked` event records both paths as JSON fields `log` and `rerunLog`; review and acceptance
evidence point to the passing rerun log. A second failure rejects once, says the gate failed twice,
and quotes the second run with both log paths. Output text never decides whether a gate flaked.
The repository's `bunfig.toml` preloads `factory/test-setup.ts`, which gives each test 20 seconds
instead of Bun's default five seconds. Bun 1.4.4 does not read a `[test].timeout` setting.

A repair reruns the full gate and gets a fresh cold reviewer. Changed code or integration base
blocks landing until revalidation; prior reports and worktrees remain available as evidence.

## Run full gates after landing (opt-in)

By default the full gate must pass before acceptance. To opt in, add both settings below to the
existing `factory/config/factory.yaml` (or the equivalent fields in a legacy flat definition), then
reload. Keep the other permission settings, including `execute: true` for a factory allowed to run.
Set `landing` to a trusted local command that is safe to run against a candidate checkout.

```yaml
scheduledGate:
  landing: bash factory/checks.sh compile
  schedule: "*/15 * * * *"
permissions:
  scheduleGates: true
```

The landing check does not replace scope checks or cold review. A fast-forward records the landed
revision, not acceptance. The existing watchdog wakes the reconciler; it does not start a second
schedule or a model for the check. An enabled factory accepts due wakes from its owner or registered
observer. The first UTC cron minute strictly after landing makes the gate due. A late wake runs it
once, not once per missed slot. The full command is the run's pinned `verify` or `checks/` list. It
runs in a detached worktree at the recorded revision and uses the normal check timeouts.

`status-summary` and the dashboard feed separate the landed revision from the verified revision.
Outgoing dependencies and further local landings wait while the full gate is unresolved. A changed
integration head makes the result stale. Inspect the target before taking action. Returning to the
exact recorded head and reconciling can run a fresh check; no old result verifies the new head.
On restart a live gate holds further work. Once its process group stops, the reconciler records an
interruption and an authorized wake can retry. The private event history records the exact revision,
base, definition digest, outcome and available log reference for each attempt.

A rejection returns to the original worker on the landed revision and follows the existing repair
attempt cap. The repaired candidate runs the full gate before acceptance. Pause or revoke
`permissions.scheduleGates` to prevent new scheduled checks. Revocation does not promote pending
landings or stop a command already running. A policy reload does not rewrite an existing pin.

### Review after the scheduled full gate (opt-in)

To move the conditional cold review after landing and full verification, enable the reviewer
(`agents/reviewer/agent.md`, or `review: true` in a flat definition) and add
`reviewStage: post-landing` inside `scheduledGate`. Reload to apply it to new pins. Without this
setting, the existing review timing stays unchanged. Small, low-risk first attempts skip the
model, not the checks. Other attempts get one opposite-family review at high effort, with no
pre-landing model review.

Landing, full verification, and acceptance are separate facts. The reviewer gets a detached
worktree at the landed SHA and compares it against the original integration base. Its verdict must
match the ticket, worker attempt, revision, base, stage, and full-gate attempt ID. Dependents and
other factory landings wait for acceptance. A rejection keeps the landed commit in place and sends
findings to the original worker. Its next candidate lands with the fast check and needs a new
scheduled full gate and review. An external integration move makes the proof stale. Restoring the
exact landed HEAD allows a fresh gate and reviewer once any ambiguous creation or delivery is
resolved. For a stale reviewer brief, a conclusive keyed lookup retires it without resending it;
an inconclusive lookup keeps the hold. Restart never blindly creates a replacement reviewer or
repeats a correction send.

## Record a merged pull request

After merging an accepted ticket, the owning Foreman calls the factory control tool with
`action: "record-merge"`, `ticket`, a positive integer `pr`, and the full 40-character merge
`commit`. Fetch the target branch first. The root checkout's configured upstream is the target
as last fetched. The action reads the PR from that branch's configured GitHub repository using
authenticated `gh`; it does not fetch, push, or merge.

Recording requires a `done` run and ancestry of the commit in that fetched remote upstream.
Both `record-merge` and `record-landing` prove the accepted change with Git patch IDs, stable by
default or verbatim with explicit path mappings as described below.
Either the combined saved-base-to-revision diff matches one landed non-merge commit (a squash),
or every non-merge commit in the accepted range has a patch-ID twin in the landed range.
On the per-commit path, each landed commit proves at most one accepted commit, even when several
accepted commits share a patch ID.
Landed commits must be reachable from the merge commit but not from the accepted base.
Empty diffs never count as matches, and an empty accepted range is refused. All diffs use `-U0`,
so changes to surrounding context do not affect patch identity. Older runs use the review base or,
without review, the accepted revision's first parent. Cherry-picked integration commits can have
different hashes and context.
For `record-merge`, GitHub must identify the PR as merged at the supplied commit. That commit must
have exactly two parents, with the second equal to the PR head. The GitHub read must identify the
commit its checks belong to and return the complete rollup for that same head. At least one check
must be present. Every check run must be `COMPLETED` with `SUCCESS`, and every status context must
be `SUCCESS`. Duplicate names with distinct check IDs are evaluated separately. Repeated IDs or
invalid pagination make the evidence unusable. A refusal leaves the ticket accepted.

After explicit operator approval, pass a nonempty `decision` to record an exception for a failed
check policy or a nonstandard parent count. This does not waive upstream or patch proof, PR
identity, a mismatched second parent, or an unavailable, incomplete or unattributed GitHub read.
The durable record stores the observed head and all check entries alongside `pr`, `commit` and
commit time `at`. An exception also stores the decision and refusal reason. Reports and fixture
tests do not substitute for recording the next real ticket merge after this change lands.

Optional `renames` uses the exact
header-only mapping proof described below. The normalized mapping is saved atomically with the
merge record in its `merge-recorded` event. Repeating the same number, commit, mapping and decision
does not write or re-read GitHub, including after restart or with reordered mapping keys. Changing
or omitting a recorded decision or mapping conflicts. Omitted and empty mappings are equivalent;
historical records remain unchanged and repeat-safe without a decision.
Recording works while paused, preserves the enabled state, and never dispatches work or changes
watchdog schedules. Backfill older accepted tickets once from their pull request records.

Each task in `/api/status` includes `merge: { pr, url, commit, at }` or `merge: null`. The URL comes
only from the root branch's configured GitHub remote and the validated number. HTTPS and SSH
GitHub.com remotes produce `https://github.com/<owner>/<repo>/pull/<pr>`; other remotes produce
`url: null`. No caller-supplied URL is accepted or stored. Private briefs and insights are excluded.

## Record a ticket landed outside the factory

If the operator approved and merged a blocked or parked candidate outside the native gate and review
path, the owning Foreman can call `record-landing`. Fetch the root checkout's configured upstream
first.
Integrate the merge into the root checkout before recording; fetching alone is insufficient.
Supply `ticket`, its exact current `incident` ID, the full worker `revision`, a positive
integer `pr`, the full merge `commit`, and a nonempty `decision` describing the external approval.
Do not use this action to bypass an unresolved gate or review.

The run must be blocked with no queued repair. A `target-changed` block without a saved checkpoint
can qualify after its candidate lands. Without a checkpoint or repair, identity comes from the
saved incident's base, attempt, ticket and owner, the run's thread, and the registered worker
worktree. Missing identity is refused; the request cannot supply it. Recovery stays `inspect`,
not `resume`. Checkpoint and repair identities keep their existing checks. Git must prove the
revision descends from the saved base and is reachable from the original worker worktree's HEAD.
An earlier candidate can qualify even when the latest report is blocked at a later attempt.
Neither report text nor the blocked reason proves ownership. The existing `verifyMerge` proof
must find either the combined accepted patch or every accepted non-merge commit's patch as
described above, and the merge commit on the fetched upstream. The merge commit must also be
reachable from the root checkout's HEAD.
Git proves the patch and ancestry, not GitHub's association between the PR number and commit.
Missing evidence, stale incidents, active or uncertain runs, and conflicting repeats are refused
without changing the run or its events.

For either `record-merge` or `record-landing`, when upstream moved a candidate's paths before
landing, supply optional `renames`, an object mapping each old repository-relative file path to its
exact landed path. Only accepted diff file headers are adapted before the combined and per-commit
patch proofs; content and upstream paths are never rewritten. Every source must occur in the
combined accepted diff. Unchanged paths, path traversal, colliding destinations, wrong or incomplete
mappings, and content drift refuse without writes.
Git-detected renames are expanded into file additions/deletions, and verbatim patch IDs preserve
path and content whitespace for this proof, including exact binary data and file modes.
For `record-landing`, the mapping is saved in the durable `landed-outside` event and must match on
repeat requests; key order does not matter. Omitted or empty mappings keep the ordinary proof.

Success stores a done run with its original base, worker, merge record and decision, closes the
incident, and appends one `landed-outside` event. An identical request, including its incident and
decision, is a no-op after reload. Recording preserves the enabled state, works while paused, and
does not dispatch, send messages, or change schedules. Dependents become eligible on the next
ordinary enabled reconciliation. Existing done tickets still use `record-merge`.

## Chronicle a landed ticket

A landed ticket gets a chronicle when its queue entry has `size: "large"` or `risky: true`
(`Task` in `factory/persistence.ts`), or the operator names one by hand. Small, low-risk
landings get none. The chronicle is two self-contained HTML artifacts: a walkthrough with real
proof that the change works, and a changes summary with a data-flow flowchart. It is a manual
Foreman procedure; it adds no factory code or schema.

Proof capture starts at admission. When the Foreman writes the admission brief for a qualifying
ticket, it appends this boilerplate paragraph:

> Proof capture for the landing chronicle: while you verify, keep the proof a reader needs to
> believe the change works. For UI changes, capture screenshots or short recordings of every
> affected state, default state first, at the sizes the ticket names. For backend or tooling
> changes, keep the command invocations and their decisive output excerpts. Attach these files
> to your completion message to the Foreman. The attachments feed a public narrative page:
> capture only what may be public, never private briefs, secrets, or runtime state.

After `record-merge` succeeds for a qualifying ticket, the owning Foreman spawns one chronicler
child thread on the light-lane model (`moonshotai/kimi-k3`, low effort). The chronicler reads
only retained records: the accepted diff from the run's accepted base to the merge commit, the
gate log at `.git/factory/<ticket>-<attempt>.log`, the post-graft review verdict at
`.git/factory/<ticket>-<attempt>-<revision>-post-graft.review.json`, the attempt report
summary, and the worker's attached proof media. It writes two self-contained HTML files with
inline styles and scripts, no external or localhost references, and media embedded as data URLs
or durable Amp attachment URLs:

1. `Walkthrough · <ticket>`: the narrative of what the agent did and why, embedding the proof
   media and quoting decisive gate-log excerpts with their log paths and revision shas.
2. `Changes · <ticket>`: what data moves where and why, with a flowchart and the load-bearing
   files called out.

The chronicler returns file paths; the Foreman publishes each file as a thread artifact with
exactly those stable titles, then links both artifacts in the ticket file at close-out and in
the merge report. Stable titles make republication idempotent. Chronicling runs after the merge
is recorded, so a chronicler failure never reopens the ticket, blocks the next dispatch, or
touches the pull request. Private briefs, incident details, and Git-metadata report paths stay
out of the pages; the chronicler's input is the public-safe subset of retained records.

## Refresh an installed adapter

Run the setup command with `--refresh` to rebuild only the repository's generated plugin:

```sh
bun factory/setup-factory.ts --repo /path/to/repository --refresh
```

Existing configuration, tickets, and runtime state stay unchanged. Reload the factory plugin
explicitly after a successful refresh. Repeated setup is a no-op only for matching installation
bytes and source identity. Old or modified generated plugins require refresh. `--check` never
writes and reports **FILES OK**, not loaded-runtime proof.

### Installed policy identity and governed fixture

The generated header binds the absolute root, factory TypeScript source digest and bundle digest.
Checks recompute these values without loading the plugin. Neither the header nor an edited
configuration proves what a running Amp session loaded. In that session, call factory control
`policy-status`: it reads the native saved owner (or the caller before initial ownership) and the
platform's `thread.agent().definition`, then compares the complete definition to this loaded
runtime's restricted agent. It returns the loaded policy digest, root, owner, current execution
permission and effective lane. A different digest after refresh requires a plugin reload and a
matching restricted owner, not copying a header into an old session.

Observed contract: `amp plugins show-docs` on CLI `0.0.1795608053-gcec25c` exposes
`registerAgentMode({ key, label, agent })`, `createAgent(config).definition`, and
`threads.get(id).agent(): Promise<Agent>`. The installed `@ampcode/plugin` declarations expose the
same methods. Static discovery uses a JSON `// @amp-agent-mode` comment. The SDK describes the
returned definition as the agent currently used by the thread. This is platform data, not an
agent name, prompt assertion or control input. Missing methods, failed reads, built-in owners and
different definitions refuse execution. Do not infer identity from transcripts. Supported agent
definition reads do not claim OS isolation or enumerate every resolved runtime permission.

The native serialized tick checks this identity before execution, repair, or automatic recovery
effects. Restart and state-change callbacks use the same tick. Status, pause and definition reload
remain available; they do not authorize dispatch. No attempt counter, human confirmation, repair
worker or fourth-attempt parking rule is replaced. Refresh does not switch this maintenance owner.
Legacy-owner migration is not automatic: cancel or unknown identity leaves ownership and work
unchanged. An explicit native handoff still needs its existing checks and never bypasses the next
execution identity check; the replacement identity is also checked before ownership or schedule
effects. Native child creation rechecks the owner after any wait for the connected tool to return.

**Coordinator-owned live procedure, separately approved. Do not run during source review.** Unit
tests use SDK-shaped doubles and disposable installation files; they are not live receipts. A
successful source gate or native acceptance is neither remote delivery nor activation approval.

1. Obtain approval for an isolated local Git fixture, plugin loading, a restricted Foreman, native
   worker/reviewer creation, schedules, tool probes and cleanup. Keep production roots, retained
   bundles, credentials and backlog outside the fixture. Use a real approved bookkeeping store,
   not `bookkeeping.fixture.ts`. Record the candidate SHA, CLI version and `show-docs` output.
2. From the accepted source directory, prepare the fixture with the commands below. Set `STORE`
   to that approved store. Initial setup leaves execution disabled and creates no Amp thread.

   ```sh copy Copy Fixture Setup
   export FIXTURE="$(mktemp -d /tmp/factory-governed-live.XXXXXX)"
   export STORE=/absolute/path/to/approved/orch/store.ts
   git -C "$FIXTURE" init -q
   mkdir "$FIXTURE/src"
   printf '# Isolated governed fixture\n' > "$FIXTURE/prd.md"
   printf 'fixture\n' > "$FIXTURE/src/example.txt"
   git -C "$FIXTURE" add .
   git -C "$FIXTURE" commit -m 'test: seed governed fixture'
   bun factory/setup-factory.ts --repo "$FIXTURE" --store "$STORE" \
     --prd prd.md --verify 'test -s src/example.txt' --scope src/ --review
   bun factory/setup-factory.ts --repo "$FIXTURE" --check
   ```

3. Record the generated header and file-check output. Repeat setup and refresh, confirming saved
   settings and native state stay unchanged. Replace the fixture plugin temporarily with an old
   installation and prove check/reuse refuse; refresh it again. These are file receipts only.
4. Open Amp in `FIXTURE` with `amp --mode factory-foreman`. This loads the fixture plugin and
   selects its registered mode; it does not switch an existing owner. Call its exact
   `factory_control_<root hash>` tool with `{"action":"policy-status"}`. Retain the original tool
   response with thread ID and timestamp. Require `verified: true`, the header's policy digest,
   exact fixture root, current owner, `execute: false`, Sol 6.2 medium, capacity one and review.
   If discovery, agent definition lookup or exact comparison fails, stop as **blocked** with that
   evidence. Do not fall back to instructions or manually supplied identity.
5. In this isolated fixture only, add one native ticket using the documented ticket schema to
   change `src/example.txt`. Obtain explicit execution authorization, set the fixture's execution
   permission true and call native `start`. Do not create worker/reviewer threads by hand. Retain
   policy-status, native creation, delivery, checked read, candidate gate and Astra 6.2 medium cold
   review receipts. Confirm the legitimate checked operation and post-approval native dispatch.
6. Request forbidden alternate shell, delegation, MCP/code-mode and batch calls in the governed
   Foreman, and forbidden alternate delegation in native worker/reviewer threads. Capture actual
   platform refusal/tool omission and zero resulting thread, message, schedule or file effects,
   not just a model's refusal prose. Confirm unrelated fixture-external threads remain unaffected.
7. Restart the fixture runtime. Prove the same restricted owner passes identity again. In a
   separately approved legacy-owner fixture, attempt start, resume and automatic reconciliation
   after reload/restart with a built-in, unavailable or mismatched owner. Retain before/after native
   state and events showing no dispatch, attempt, permission or ownership changes. Cancellation of
   any explicit migration must leave that owner unchanged.
8. Exercise rejection and same-worker repair through native reports and cold review. Confirm the
   fourth rejection parks, and capped resume refuses decline, missing attribution and stale
   confirmation, then permits exactly the authenticated approved repair without replacing its
   worker. Keep raw platform receipts separate from unit-test output. Transcript reads retain SDK
   pagination limits; permanent deletion stays unsupported, not emulated by archive.
9. Pause through native control, confirm only the fixture's owned schedule is cleared, then stop
   its Amp session. Retain receipts before any separately approved fixture cleanup. Report source
   gate, cold review, remote delivery and live activation as distinct results, including any blocked
   criterion. This procedure has not been executed as part of F043 source implementation.

### Dashboard service declaration

Setup and `--refresh` also install a self-contained copy of the dashboard in
`.amp/factory/` (`dashboard.js` and its fallback `dashboard.html`) and declare a
`factory-dashboard` service in the repository's `.amp/services.yaml`, so a new orb can start it with
`amp orb services ensure`. The command is the constant `bun .amp/factory/dashboard.js --repo .`:
it names only repository-local files, never the checkout that ran setup, and the installed
repository can move to another directory or orb. Like the plugin, the copy is generated and
git-excluded, so run `--refresh` after a fresh clone. Setup and every refresh add any missing
exclude rule to `.git/info/exclude` and leave existing lines alone, so an install made before the
dashboard copy existed is also covered. The service runs only the dashboard on port
4310. It grants no execution, schedule, ticket or push permission.

The application's own services file is never rewritten or reformatted: the entry is appended after
the existing text. Setup and refresh refuse, before writing anything, when the file already declares
a different `factory-dashboard` or when the entry cannot be appended without reformatting (for
example a file indented by four spaces). Add the entry by hand in that case. An identical entry is
left alone, so repeated setup and refresh runs leave every byte unchanged. `--check` reports a
missing runtime copy or a missing or conflicting declaration and writes nothing. Setup does not
start any service.

## Inspect a suspected worker or reviewer stall

Connected reconciliation samples `amp.get_thread_status` for the delivered worker or reviewer.
The sample must name the matching thread and contain a recognized state and timestamp. The factory
saves each changed sample with a hash of the worktree's HEAD, status, and changed file contents.
A later identical `running_tools` sample at or past three minutes opens a `disconnected` stop.
If the worktree changes, the stall clock starts over at the time the factory sees the change.
At the default cadence, the stop can open on the next connected wake after the threshold, not
exactly at three minutes. Unavailable status or worktree evidence cannot open a stop.

This is a suspected stall, not a confirmed executor failure. The stop keeps the same thread,
attempt, and worktree. A changed timestamp, worktree, or transition out of `running_tools` in a
connected sample clears the stop. `reconnect` names an operator decision. The factory does not
reconnect or replace a thread, and it does not classify unobserved executor-error replies.

Server-confirmed idle candidates still require the existing revision, allowed-path, clean-tree,
verification, and integration checks. Idle without a report is not acceptance. Status and pause do
not attach observers. Failed attachments can be retried by a later active reconciliation.
Reconciliation respects the paused queue and `permissions.execute`; it does not grant permission.

## Dashboard

Run the dashboard against a repository with an installed, loaded factory plugin:

```sh
bun factory/dashboard.ts --repo /path/to/repository
```

The service uses `PORT` or defaults to 4310 and binds to loopback. In an Amp orb, run it as a
supervised service and expose it through an authenticated portal:

```sh
amp orb service start factory-dashboard \
  --command 'bun factory/dashboard.ts --repo /path/to/repository' --port 4310 --portal
```

Use the portal URL returned by Amp. Do not expose the loopback service directly on a public host.
Setup declares this service for a managed repository (see
[Dashboard service declaration](#dashboard-service-declaration)); these commands run the source
available in this checkout, not a published package. Non-GET requests answer 405, except the
authenticated automation request endpoint described below.

### Automation controls

The Automations section shows each loaded automation's UTC cron schedule, enabled state, last
run time and send outcome. The switch and **Run now** queue requests. They do not edit schedules,
send prompts, admit tickets or start the factory. A pending request waits for the next connected
owner wake or explicit owner `reconcile`. Observer and disconnected reconciles cannot apply it.
Requests apply oldest first through the same checks as `automation-enable`, `automation-disable`
and `automation-run`, including while paused. Requests older than one hour are refused with a
visible reason. A reserved request whose effect is interrupted stays refused with an unknown
outcome and is never retried automatically. Inspect state before submitting another request.

Setup and `--refresh` create `.git/factory/control-token` with owner-only file access, preserving
an existing token. Read that file locally and paste its value into **Operator token**, then click
**Save token**. The page stores it in local storage for this origin. **Forget token** clears that
browser's copy. Never put the token in a URL, a ticket, a screenshot or a published file. Delete
the token file locally and rerun setup with `--refresh` to rotate it; other browsers must then
paste the new value. Anyone holding the token can request these three automation actions. Portal
sign-in alone is not authorization to control the factory.

For a portal, set `FACTORY_CONTROL_ORIGIN` in the dashboard process environment to its exact
public origin, such as `https://your-dashboard.example`, with no trailing slash. Restart the
dashboard after configuring it. Without this setting, POSTs accept only the direct request URL's
origin. Proxy headers never select the trusted origin. This also means a Vite proxy needs the
Vite page's origin configured on the dashboard during development.

The Foreman's live header-echo preflight on this orb observed only `x-forwarded-host`,
`x-forwarded-port: 443` and `x-forwarded-proto: https`. No usable identity or authorization header
reached the origin, so token delivery uses the operator-pasted fallback. Requests from inside the
orb bypassed the sign-in page; the headless sign-in exchange completed but exposed no cookie to
curl. The external signed-in browser path was not directly observed. These observations do not
establish an identity contract. There is no `GET /api/control-token` endpoint.

`POST /api/automations/<name>` accepts only JSON with one `action` field (`enable`, `disable` or
`run`), an `Authorization: Bearer <token>` header and an exact `Origin` match. A valid request
inserts one durable SQLite intent and returns 202 with its ID and `status: "pending"`. Missing or
incorrect tokens return 401; absent or different origins return 403. Both write nothing. There
is no CORS opt-in. All other non-GET paths remain read-only. The bearer token prevents blind
requests, and the origin check prevents cross-site browser posts even with a supplied token.
Same-origin script compromise or a stolen token used outside a browser is outside that defense;
serve only trusted dashboard assets and keep the token private.

`GET /api/status` includes `automations` with `name`, `schedule`, `enabled`, `lastRunAt`,
`lastOutcome` and `requests` (ID, name, action, timestamp, status and refusal reason). It never
includes automation prompt bodies or the control token. Reads and HTTP writes cannot invoke Amp
tools; only the plugin's connected owner turn can apply intents.

An individual action failure refuses that request with its error and does not stop later requests
or the owner reconciliation. Requests for an automation removed by reload remain visible as
**No longer loaded**, with controls disabled and their pending or refused result preserved.
Their status row has a null `schedule`; no removed prompt or last-run state is reconstructed.

### Pipeline view

Build the pipeline page in the repository served by `--repo` before starting the dashboard:

```sh
bun run web:build
amp orb service start factory-dashboard --command 'bun factory/dashboard.ts' --port 4310 --portal
```

The same service serves `web/dist/index.html` at `/` and `/index.html`, generated files under
`/assets/`, and the read-only `/api/status`, `/api/events` and `/api/evidence`. No Vite server,
relay, cross-orb proxy, or sign-in cookie refresh is needed. Restart the service after rebuilding.
Without a build, the existing activity page remains available.

For frontend development, `amp orb services ensure` starts the recorded replay and Vite services
from `.amp/services.yaml`. That preview is labeled recorded data, not a live factory. To develop
against a local dashboard, run `bun run web`; `FACTORY_API` overrides its default API proxy target
`http://127.0.0.1:4310`. The built page reads both APIs on its own origin.

### Lifecycle graph

The page's Lifecycle section draws the declared transition table, which the feed carries as
`lifecycle` (from `lifecycleStatus()`) beside `stages`. Nothing is drawn by hand: every state, stop
and exit comes from the table, so a stop the table gives no exit is drawn with a "no exit" cue and
its declared reason, and no exit appears that the table lacks. `queued` and `planned` come before
the run kinds and are not in the table.

- The path runs left to right, numbered: `planned`, `queued`, `preparing`, `creating`, `running`,
  `done`. Below it, each state that has stops lists them, with the kinds that only hold stopped
  runs (`preparation-failed`, `blocked`, `parked`, `uncertain`).
- Each ticket is a marker on the state its feed `kind` and `stopName` select, linked to its
  thread, and prints the ticket's own curated `stage` and `actor` (nobody when null), so a gating
  run on `running` or an accepted and a merged run on `done` read differently. The state's own
  actor is labelled "declared". The page never maps a stage to a state.
- Groups and stops sort by who must act, most urgent first: the operator, the Foreman, a clock
  wait (dim, with a countdown to `clearsAt`), then work in progress, then quiet states. The
  actors are the ones `runLifecycle` declares. Ties keep table order.
- A count of tickets whose `actor` is the operator is always shown at the top of the section.
- A ticket on a stop gets a banner with who must act, the stop's reason, the stop's exit
  actions, the causing thread with its role, and when the stage began. A run with no recorded stop
  lists the exits its kind's stops declare, and says "no exit" only when none declares one.
  Colour keeps the page's meaning (green done, orange now, red stopped with the text "stopped",
  unlit when empty or queued; a clock wait stays dim); `uncertain` states say "outcome unknown".
  The banner and the ticket sheet print the reason code's fixed sentence from `web/derive.ts`.

The section is read-only; `web/replay.ts` frames 19 to
22 show an empty factory, one running ticket, one stopped ticket and four tickets on one state.

### Event trace

`GET /api/events?after=0&limit=100` is the supported trace for operators and agents without
opening private state. The response is `{ durable, events }`. Rows are oldest first, strictly after
the integer `id` cursor. `after` defaults to 0 and must be a nonnegative safe integer. `limit`
defaults to 100 and must be an integer from 1 through 500. Invalid bounds return HTTP 400.
Pass the last returned `id` as `after` on the next request. Keep your cursor if the page is empty.
IDs, not timestamps, order events across equal timestamps and dashboard restarts.

Each row has `id`, `at` (the stored timestamp), `ticket`, and `action`. Optional fields are
`attempt` (a positive safe integer), `revision` (40 lowercase hexadecimal characters), and `thread`
(a `T-` ID containing letters, digits, underscores, or hyphens). A first rejection adds `reason`,
one of its closed codes. JSON details for preparation, setup-spawned, rejected, repair-resumed,
and review creation or delivery supply only these validated fields.
Legacy accepted revisions and created, sent, sending, or provider-continuation thread references
are validated too. Unknown actions remain visible without any detail-derived fields.
`report-received` adds `reportKind` (`candidate` or `blocked`), and `gate-returned` adds
`gateOutcome`. A candidate that fails preflight records `gate-not-run` without `gate-started`.
A recorded `review-verdict` adds `reviewOutcome: "pass"` or `"issues"`.
`review-skipped` adds `reviewOutcome: "skipped"` and `skipReason` (`review-disabled` or
`small-low-risk`). A new `rejected` row also supplies `nextAttempt`. Escalation, parking and
watchdog rows can include `incident`, an opaque reference. Older events can lack these fields.
Briefs, paths, verdict findings, arbitrary text, and all other detail fields stay private.

Missing storage returns HTTP 200 with `durable: "missing"` and `events: []`, like `/api/status`.
Invalid storage returns HTTP 503 with `durable: "invalid"`; exhausted lock waits return 503 with
`durable: "unavailable"`. Reads never initialize, import, migrate, or write storage.

`GET /api/evidence?ticket=<id>` lists a known ticket's retained evidence as
`{ durable, ticket, evidence }`. Each row has `attempt`, `kind`, `revision`, `outcome`,
`definition`, `sha256`, `bytes`, `at` and `preserved`, which is false when the stored content is
missing or no longer matches its digest. Content, paths and producing tools are never served.
A missing or malformed ticket, or any other query parameter, returns HTTP 400; an unknown ticket
returns 404. No request value names a file. Storage failures follow the event trace's 503 rules.
Choose a ticket in the workbench and open **Inspect evidence** with Enter, Space or a click.
The panel reads only this ticket's curated metadata. Close and reopen it to refresh. A recorded
outcome does not mean its artifact is still preserved. Missing acceptance or review proof is not
a pass. The replay serves illustrative evidence; `?demo` has no recorded evidence.

The bottom **Event log** bar opens upward with a click, Enter, or Space. Escape closes it and
returns focus to the bar. The list shows time, ticket, action, attempt, and available thread links.
The ticket selector filters locally. New rows arrive on the existing five-second timer and scroll
into view only while the reader is at the end. Scrolling up keeps the reading position.
The drawer and filter reset on reload. Notices use received events, not inferred poll differences.
The replay includes labelled illustrative event rows; it is not a private event-log export.
A first rejection's notice prints its reason sentence and the failed attempt. Polling clients can
replay the recorded rejection and next attempt after the worker has already started its repair.

### Pipeline motion

Motion is derived by comparing consecutive polls: a ticket that becomes accepted plays the landing
(packet, press, screen shake, cold review, new commit on main), one that becomes blocked sends a
red packet back to its builder, and a queued one that starts work gets a brief from the foreman
layer through the hand-off. The dashed lane from the return loop up to the foreman is a
placeholder that only the replay button animates. Stale observations stop all motion. Append
`?demo` for labeled sample data.
**Reduce motion** stops the workbench animations without stopping polling or hiding records.
The workbench also honors the system reduced-motion setting and disables sample playback in
either reduced-motion mode. A pending review disappearing does not establish a rejection;
the release animation needs a recorded outcome for the pending attempt. It can match a rejection
before or after the corresponding status change. A scheduled gate on a landed revision does not
keep cold review pending. If the first status read fails, the workbench does not show queue counts;
after a successful read, an outage keeps the last known state visible with an offline warning.
The `replay` button reruns these animations for review without touching factory state. It also
plays a cold review that returns fixes and a green and a red full gate; the feed reports none of
those yet. Cold review runs before the merge and is skipped for small low-risk first attempts.
The gate-to-main wire runs straight past the review box, which hangs below on its own branch. A
landing detours through it only when the accepted task has `evidence.review`; with no recorded
review it stays on the wire, which does not prove the review was skipped. The verify chips tick on
a fixed timeline, not live check results.
The press turns the packet into a ball; in cold review two `FREEZER` doors fill the box, slide shut
on it and three puffs of mist (small, medium, large, placed at random each time) leave the seal
while the sweep runs behind them.

Below the pipeline, ACTIVE shows the current ticket's stage pills (green = done, amber = now),
read from its feed `step` and `stage`, and a box that expands the gate pill into the integrator's
checks. The wire from the pill to the box turns amber while the ticket is idle, which is when the
gate runs. COMING lists the next two tickets, and its dots show every ticket's status in order.

The feed's `target` field is the root checkout's current branch. The page shows it as the dotted
pill after `ff-merge` and as the label of the commit lane. A builder whose ticket just landed is
outlined green for one poll. Hovering a builder, queue dot or commit dot shows its ticket id,
title, status and revision.

A COMING row shows the ticket's own steps as chips when its feed task has a `steps` list of short
labels, and the generic stage pills otherwise. Steps that do not fit the row are dropped.

The plugin publishes a sanitized observation file under the target Git directory. Native Amp
state and title subscriptions trigger updates; a five-second heartbeat refreshes observations.
The browser polls the read-only `/api/status` endpoint every five seconds. SQLite supplies retained
ticket/run identity, enabled state, and acceptance, even without a heartbeat or current manifest
entry. Public titles use ticket IDs, with a delivery label for reviews. Private briefs
and native thread titles are not public title sources. HTTP ignores observed titles, including
matching fresh or stale legacy observations, without rewriting historical files. Activity remains
an observation: `observedAt` is never advanced by an HTTP read.
`fresh` requires an observation less than 20 seconds old and no more than five seconds in the
future.
Missing, invalid, or stale observations cannot advertise working agents. Activity must also match
the durable thread and revision. Reviewer activity also requires a snapshot taken after prompt
delivery; older snapshots without this fact do not supply reviewer activity. Observations alone
cannot accept work or introduce tickets.
Retained tickets without runs are displayed as queued even after removal from the manifest. They
can inflate the displayed queue count, but the dispatcher will not start removed tickets. Status
does not claim to be a current dispatch plan.

Queue tickets accept optional `steps: string[]` with ordered, nonblank authored labels. Non-array
values, non-string elements, and blank labels are rejected. Omitted labels remain compatible with
older queues, SQLite tickets, and observation snapshots. Use public three-to-five-word labels;
keep implementation sentences in the ticket, and private briefs or report paths out of labels.
See the [ticket authoring skill](../.agents/skills/creating-factory-tickets/SKILL.md) for a matching
ticket and queue example.

The response retains `project`, `observedAt`, `enabled`, `fresh`, and the existing task fields.
Top-level `target` reads the root checkout's current Git branch on each request, including when
storage is missing. An empty branch name returns `detached HEAD`. Branch changes require no restart.
Each task's `steps` comes from retained SQLite ticket data, or `[]` for unlabeled historical tickets
and run-only identities. Labels survive missing or stale observations and removal from the queue.
Snapshots carry validated labels but cannot override durable labels in HTTP responses. Malformed
snapshot labels invalidate observations; malformed durable labels return invalid storage. Neither
labels nor their order indicate the current step. No current-step progress is inferred.
`durable` is `available`, `missing`, `invalid`, or `unavailable`; `observations` independently
reports `available`, `missing`, or `invalid`. A missing database returns an empty, non-fresh status,
not legacy acceptance.
Invalid or unsupported SQLite returns HTTP 503 with `durable: "invalid"`. Malformed observations
do not hide valid durable acceptance. GET never initializes, imports, migrates, or rewrites storage.
All storage connections use a connection-local five-second busy timeout so dashboard readers and
coordinator commits wait for ordinary lock overlap. An exhausted lock wait returns HTTP 503 with
`durable: "unavailable"`, not invalid storage; retry after the competing transaction finishes.

Each task adds `attempt`, the owning worker's current attempt from its durable run, or `null` when
no worker run carries one. A repair after a rejection raises it; it is not a review verdict.
`waitingForForeman` marks a saved escalation checkpoint, not a failed heartbeat or an even
attempt number. `workerThread` stays tied to the builder while `reviewerThread` names the assigned
reviewer. Pending reviewer creation has no live `activity` and does not mean a rejection.
`checks` lists the last recorded gate's `attempt` and `results` (check `name`, `required`, and
`status`). `stop` includes the incident `id`, owning Foreman `owner`, closed `reason`, optional
cause `role` and `thread`, and `notifiedAt`. A missing stop is `null`.
`stall` is `null` unless storage records a watchdog suspicion or disconnection. Otherwise it
contains `id`, `reason` (`no-lifecycle-progress` or `disconnected`), `since`, `detectedAt`,
`lastNudgedAt`, and `nudgeCount` for the current episode. Counts are reservations, not confirmed
deliveries. A disconnected stall uses the stop incident ID and excludes nudges from other episodes.
Reads do not issue alerts or nudges.

For example, the native HTTP fixture that accepts an attempt with review disabled produces these
task fields (event IDs, timestamps, and revision shown as examples):

```json
{
  "attempt": 1,
  "waitingForForeman": false,
  "reportReceipt": {
    "eventId": 12,
    "at": "2026-11-27T00:00:00.000Z",
    "attempt": 1,
    "kind": "candidate",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "reviewDecision": {
    "eventId": 15,
    "at": "2026-11-27T00:00:00.000Z",
    "attempt": 1,
    "outcome": "skipped",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reason": "review-disabled"
  }
}
```

The receipt names the submitted revision, which may differ from the rebased review revision.
Its revision is `null` for a blocked report. `reportReceipt` and `reviewDecision` are `null`
without a matching recorded fact. A legacy acceptance without a decision is unknown, not skipped.
An `issues` verdict remains visible at a review-triggered escalation or park when the recorded
review identity matches the stop. It does not carry forward to the resumed attempt.
Each task adds `evidence`: an `acceptance` revision when accepted, and `gate`/`review` references
only when a bound review record exists. References include revision, base, and stage; review
also includes attempt, pending state, and the available reviewer thread. An absent reference is
`null`, not an inferred success. Legacy gate-only acceptance has no retained gate reference.
Private report/log paths, commands, requirements, verdict contents, worker rationale, configuration,
and raw event details are not served. Review titles omit paths, including in older observation
files.
Only the selected HTML, built assets, and GET `/api/status`, `/api/events`, `/api/evidence` and
`/api/definition` are served. Source files, private factory files, other paths, and write methods
are rejected.
No model call is used for observation, HTTP reads, or rendering.

**Sample preview** switches to clearly labeled illustrative data. It never starts workers or
modifies the repository. The selector exercises working, blocked, idle, disconnected, and empty
states. **Pause motion** affects visuals only, not the factory. Reduced-motion preferences disable
looping movement. **Back up now** is intentionally disabled until its backend is implemented.

The current screen shows ticket IDs and review labels, available thread links, and accepted revision
hashes. PR metadata, conversation history, and evidence browsing remain backlog work.

## Restricted role capabilities and checked threads

`factory/capabilities.ts` defines the capabilities used by generated installed policy.
`restrictedForeman(root, model)` returns an agent definition with exactly this root's factory
control tool and no shell, raw thread, delegation, plugin wildcard or arbitrary MCP tools.
The adapter's optional trusted `restrictedForeman` thread ID binds interception to that identity.
It does not claim ownership, change modes, create a Foreman, install anything or activate policy
for an existing maintenance owner. Generated installation supplies a source-policy digest instead
and governs the native owner with the shared execution identity check described above. Live
governed fixture proof remains separately approved and deferred, not established by unit tests.

Native child creation selects exact tools by role. Workers and reviewers retain `Read`, patching
and shell execution/status/termination for implementation and review reports. Observers have only
the root's control tool. Every selection explicitly excludes both `tool_search` and `code_exec`:
the installed SDK otherwise adds these deferred MCP routes even with an explicit include list.
The `tool.call` guard derives child roles from native runs, including retained repair/checkpoint
identities, and the `foreman.children` identities saved atomically with new native creations.
Rejected or replaced reviewers remain governed and scoped to their ticket across restart; no
role is inferred from a missing report or prompt. Legacy current runs stay readable without
adopting historical candidates. Unknown calls, direct delegation, arbitrary plugins/MCP and
batch wrappers are refused
before execution. Rejecting a whole batch also rejects forbidden nested calls. Child controls
permit only `message-foreman`; observers additionally retain reconcile and the bounded summary.
Retired identities refuse all governed calls. Unrelated threads keep their existing behavior.
This is application capability control, not OS, filesystem or credential isolation: a worker's
legitimate shell can still access its environment. F028 owns that separate boundary.

The factory control tool supplies these typed, owner-only thread requests:

- `create-thread` accepts only `ticket` and `role` (`worker` or `reviewer`). It requests native
  reconciliation for that identity, not an alternate launcher. Native state supplies attempts,
  assignments, candidate, model, executor and lane. Worker dispatch uses the existing eligibility
  and lane checks; a held lane creates nothing. Reviewer requests use ordinary candidate gates
  and staging. Paused or execution-disabled factories refuse. Existing or uncertain creations
  refuse replacement requests; inspect and use the existing exact-incident recovery instead.
  Prompts, attempt/base/candidate/executor overrides are refused, including on direct invocation.
- `read-thread` accepts an owned `thread`, plus SDK `full`, `from` (`start` or `end`), `offset`
  and `limit` (1 to 20). Pagination and original content are preserved. Prose cannot grant
  authority or acceptance. Current owner and registered worker/reviewer/observer targets are in
  scope; arbitrary outside access is explicitly unsupported, not approved by model-written text.
- `archive-thread` accepts only an owned `thread`. It refuses the current owner, active observer,
  unmerged worker/reviewer evidence, and any target still required for review or recovery.
  Connected platform inspection must prove the exact target, viewer ownership and idle activity.
  Failed or unrecognized observations never mean idle. Identity is rechecked under the existing
  native lock. Archive reserves a durable effect before calling observed `amp.update_thread`
  with `{thread, archived: true}`; it never removes a worktree or transcript. Read-back through
  `amp.get_thread_status` must confirm `metadata.threadID`, `viewerOwnsThread` and `archived`.
  A lost acknowledgement or failed read-back is unknown, not permission to repeat. Subsequent
  requests inspect the result without repeating the effect, including across restart. An
  unchanged inspection writes no event. No approval wait or model-supplied decision is used.
- `delete-thread` explicitly refuses permanent deletion as unsupported. It never substitutes
  archive, deletes evidence, or changes native counters or lifecycle state.

Contracts were inspected through installed `amp plugins show-docs`, `show-agent-options --json`
and connected `amp.get_thread_status` / `amp.update_thread` descriptions. The status metadata
shape was also observed in a connected read. Unit tests simulate effects; they do not prove a
live installed policy or successful platform archiving. Authenticated capped resume, normal
review/rejection gates and native incident recovery remain unchanged.

## Checks

```sh
bun install --frozen-lockfile
bun run lint:ci
bun run typecheck
bun run format:check
bun test
bun run fallow:ci
```

Every `bun test` loads `factory/test-setup.ts` before loading test files. It keeps the 20 s
default test timeout and takes an exclusive OS lock on `/tmp/software-factory-bun-test.lock`.
All checkouts on the machine share that path. The system `/usr/bin/flock` command must be installed.
The Bun process holds the file descriptor, so exit or SIGKILL releases the lock. Do not delete
the lock file; its stored PID can be stale when no run holds the lock.

A waiting run writes `Waiting for test lock held by PID <pid> (<seconds>s elapsed)` to stderr
every 30 s. Waiting precedes test timers, but counts toward the timeout of the gate command or
check that runs the tests. A gate that spends that budget waiting still times out. Builds and
lint do not take this lock.

Installation enables Lefthook. Pre-commit runs type-aware correctness and async-safety lint,
Oxlint's native TypeScript check over both `src` and `factory`, and a staged-diff Fallow audit.
Use `lint:type-aware:fix` to apply available lint fixes. CI additionally rejects lint warnings,
checks formatting, runs every test, rejects focused tests and conflict markers, and applies
strict whole-project Fallow checks. Changed-code attribution is restricted to pre-commit;
CI does not exempt inherited
findings. Fallow's built-in CI mode runs dead-code, duplication, and health analysis with failure
on findings. Three-occurrence duplication detection follows Yaklabs' configuration.

The locked development dependencies supply Amp's CLI and official plugin types. Tests use a
bookkeeping fixture instead of requiring a personal Amp skill installation; factory Git operations,
SQLite persistence, verification commands, and installer bundling remain real. This suite does not
prove the external poteto store's cross-process lock or a live authenticated Amp dispatch.

The API check uses a disposable Git repo and real HTTP requests. It covers fresh and stale
observations, durable acceptance without a heartbeat, pending review references, private canaries,
unchanged SQLite bytes, malformed storage, and rejection of file access and mutation requests.
Native dispatch tests use real Git worktrees and configured verification commands, replacing remote
thread operations and external bookkeeping. Live native trials and browser checks are separate
evidence.
