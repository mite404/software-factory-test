# Factory prototype

The dispatcher uses Bun SQLite persistence and native Amp thread APIs. Cross-orb code transfer,
worker retirement, and dashboard chat are not implemented. Requirements and remaining
stories live in [the backlog](../docs/backlog.md).

The [Foreman prompt](foreman.md) defines the current sequential orchestration procedure. It is a
reusable prompt, not an automatically installed agent mode or a change to worker instructions.

## Project definition and reload

The project owns one version-1 definition: `factory/definition.yaml`, or legacy `.factory.json`.
Both use the settings described by `factory/definition.schema.json`; instructions remain in the
Markdown file referenced by `prd`. Independent copies of both definition files are a conflict,
not an override order. Checks reject unknown settings, unsupported capabilities and unsafe paths.

Run `bun factory/setup-factory.ts --repo /local/project/root --migrate` to move a validated legacy
definition explicitly. Migration preserves its bytes, ownership and mode without overwriting an
existing destination. JSON remains valid YAML. Repeating migration is safe, including recovery
after an interrupted move. Checks, refresh, status and ordinary reads never migrate definitions.
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

## Durable coordinator state

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

Every two failed verification or review attempts escalate to the Foreman. The blocked record retains
the original worker and repair checkpoint. The owning Foreman can call `resume` with `ticket`, the
current `incident` ID, and a nonempty `decision` after inspecting the evidence. This queues the same
worker at the next attempt. It does not accept code or start a paused factory. Use `start`
separately when paused. Resumption requires an idle worker, its registered clean worktree, and an
unchanged integration base. Old two-attempt review blocks can recover from matching durable review
events and the candidate report. Missing recovery evidence fails closed. Subsequent candidates still
require the normal gates.

Actionable stops persist an `incident` in the run, in the same SQLite transaction as the stop event.
Its ID binds the ticket, attempt, base, and owner to a curated reason and recovery action.
Preparation uses `retry-setup`; ambiguous creation or delivery and changed integration or review
identity require inspection. Only a saved worker checkpoint supports `resume`. Permission blockers
grant no authority.
Serialized reconciliation sends queued notices to the owning Foreman through `host.send`, including
after adapter restart and while execution is paused. Failed or ambiguous sends remain queued for the
next reconciliation. A successful append with a lost acknowledgment can produce duplicate notices.
Successful delivery is recorded durably and does not repeat normally. Owner replacement readdresses
the notice with a new ID. A stale ID cannot resume a later checkpoint or a different owner's stop.
Status and HTTP reads neither drain notices nor change incident state. Notices contain no private
worker reasons, instructions, paths, or review findings; diagnosis uses the private saved evidence.

Serialized lifecycle reconciliation also checks a progress watchdog. The optional definition setting
`watchdog` contains positive safe integers `suspicionMs` (default 1800000), `spendingFirstAttempt`
(default 6), and `spendingInterval` (default 4). All three are required when the setting is
supplied.
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
parking safe work or resetting the progress clock. Existing two-rejection checkpoints still apply.

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

Authorized `start` installs one existing-thread watchdog, every 30 minutes, before dispatch. The
stable SHA-256 fingerprint binds the software factory identity, root and Git storage directory.
Ownership uses the fingerprint in the title or prompt, not the prompt wording or echoed settings.
Repeated start accepts its owned, enabled registration. An owned schedule with changed recurrence,
run mode or enabled state is drifted, not foreign: it stays safe to clear, but is not reported as
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
No keepAlive lease, global scheduler or hosted
monitor is installed. Legacy SQLite opens unchanged; monitor metadata is added transactionally on
the first connected lifecycle effect without changing existing definition pins or incident IDs.

Pause persists the local stop before inspecting or clearing any remote schedule. Non-worker,
non-reviewer threads can pause, reconcile or reload without schedule or alert effects; the owning
Foreman's next connected turn clears its watchdog after such a pause. This local stop remains
available if the owner cannot start. Only the connected owner can start monitored execution or
resume a repair. A changed root/Git path after copy or restore records a durable fingerprint
conflict, not an installed monitor. Pause still persists even if its tool result reports that
conflict. Restore the original root and Git storage paths before connected recovery. Automatic
fingerprint migration to a new path is unsupported: inspect the old thread's schedule and seek an
explicit adoption decision rather than editing the fingerprint or clearing an unrelated schedule.

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
  `runMode` and `enabled`; ignore the platform anchor and unknown metadata. Fingerprint alone
  determines ownership, even when those settings drift.
- `clear_schedule` returned `{"deleted":true}`; the next `get_schedule` returned `null`.

Plugin bridge result wrapping remains unobserved. The adapter accepts parsed objects and JSON
strings; other shapes leave monitoring unconfirmed without replacing a schedule. Controlled
fixtures reproduce this observed contract and reject invalid notification input. They do not prove
sleeping-orb wake, plugin bridge wrapping or actual push/email delivery.

Explicitly paused factories, completed runs and planned/dependency-only work produce no watchdog
nudges or alerts. Status, heartbeat publishing and HTTP reads remain read-only and do not deliver
messages.

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
`action: "backup"`. Both call the same backend. The command accepts no destination overrides.
Metadata must identify the configured repository as private on GitHub.com before publication
proceeds, with explicit `PRIVATE` visibility. Enterprise-internal repositories are refused.
Both the metadata lookup and publication target GitHub.com, regardless of `GH_HOST`.

Only `projects/<projectKey>/state.sqlite` and `manifest.json` are staged. The manifest contains the
stable project key, schema version, and application revision. SQLite `VACUUM INTO` creates a
consistent snapshot, then `integrity_check` validates it. Both run asynchronously outside the
plugin process. The operation works with rollback journals and WAL. In rollback mode, concurrent
writers can encounter SQLite's normal read-lock contention. It does not change database settings.
The snapshot subprocess uses the installed `bun` executable on `PATH`, including inside Amp's
compiled plugin host. It does not depend on `process.execPath` being Bun or on `BUN_BE_BUN`.

The Git directory contains `factory/backup/receipt.json` and a retained publication workspace.
The receipt records pending, confirmed, failed, or uncertain publication and preserves the last
confirmed remote revision. That revision describes its snapshot, not later coordinator changes.
Receipts stay outside SQLite so unchanged input produces no new commit. A filesystem lock rejects
overlapping requests. After an interrupted process, inspect its receipt and confirm no backup is
running before removing `factory/backup/lock` and retrying. Retry restores only the selected project
key's generated snapshot and manifest to their committed versions, removing untracked copies.
It then regenerates both files, so an interrupted staging or failed commit does not block recovery.

Pushes never force the branch. Confirmation fetches the remote and checks that it contains the
intended commit, including when a push response is lost. If confirmation is unavailable, the
receipt stays uncertain. Retry inspects the remote before another push. After a successful fetch,
a pending revision missing from a recreated workspace is not published on that branch.
Unpublished local backup commits rebase onto the fetched tip, preserving unrelated project changes.
A same-path conflict aborts the rebase and refuses publication without discarding either side.
Changes outside the two generated paths also fail without discarding files. Preserve the workspace
for inspection. Known safety refusals identify the cause; external diagnostics stay hidden.

Restore is not implemented. A snapshot covers only SQLite coordinator state. Private candidate
reports, worktrees, lessons, the poteto ledger, and dashboard observations are not included.
They require separate recovery evidence. Tests use disposable local remotes, never GitHub writes.

## Worker settings

Fresh setup defaults to `openai/gpt-6.1-sol` with `workerEffort: "medium"`. Choose a model with
`--worker-model` and effort with `--worker-effort`. Supported native Amp effort values are `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Invalid CLI effort fails before setup writes. Invalid saved effort blocks checks and dispatch
before worker creation.

Existing configuration without `workerEffort` keeps Amp's model default and is not rewritten.
Repeated setup and refresh preserve saved model, effort, permissions, tickets, and runtime state.
To change future workers, edit `workerModel` and `workerEffort` in the project definition,
then reload. These settings apply only when creating a new worker. Corrections continue with
the original settings, not a replacement.

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
preparation succeeds, worker creation starts at implementation attempt one. Ambiguous thread
creation or delivery remains parked and cannot be retried with `retry-setup`.

## Conditional post-graft review

Review is opt-in: pass `--review` during initial setup or set `review: true` in the project
definition and reload for future runs.
Missing or false preserves gate-only acceptance. Refresh never enables review or rewrites saved
configuration. Invalid review, ticket size, or risk values fail parsing.

Tickets may declare `size: "small" | "medium" | "large"` and boolean `risky`. With review enabled,
only a small, low-risk first attempt skips review. Medium, large, unrated, risky, and retried work
requires one cold post-graft review, never a pre-graft review or a model call to classify risk.

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
never worker messages, insights, self-review, or prior reviewer opinions. Its only permitted write
is its JSON verdict report. Findings require severity, location, concrete evidence, and an
actionable correction; empty findings can pass. Narrative text and idle state cannot approve a
candidate.

Review identity, delivery, verdict evidence, and events live in the existing SQLite run state.
The dashboard's existing title, thread, revision, and activity fields project the pending review.
Reloads reattach reviewers without replacements. Unknown creation or delivery stays parked for
operator reconciliation; missing, invalid, blocked, stale, or unavailable verdicts cannot land or
consume corrections. Issues return to the original worker, with Foreman escalation after every
two verification or review rejections. Owner-only `resume` records the next repair decision.
A repair reruns the full gate and gets a fresh cold reviewer. Changed code or integration base
blocks landing until revalidation; prior reports and worktrees remain available as evidence.

## Refresh an installed adapter

Run the setup command with `--refresh` to rebuild only the repository's generated plugin:

```sh
bun factory/setup-factory.ts --repo /path/to/repository --refresh
```

Existing configuration, tickets, and runtime state stay unchanged. Reload the factory plugin
explicitly after a successful refresh. Ordinary repeated setup remains a no-op, and `--check` never
writes.

## Recover a disconnected worker

Use the factory control tool's `reconcile` action after reloading the plugin. Native Amp state stays
the primary observation. If the native read fails, an explicit control invocation can use
`amp.get_thread_status` through its invocation context. The adapter trusts only structured results
whose `metadata.threadID` matches the worker and whose `agentState.state` is recognized.

Unavailable or invalid observations remain unknown. The factory retains the running record,
attempt, report, worktree, and thread for a later reconciliation. Unknown observations never imply
idle or acceptance. Background recovery has no invocation context and cannot use this fallback.

Server-confirmed idle candidates still require the existing revision, allowed-path, clean-tree,
verification, and integration checks. Idle without a report is not acceptance. Status and pause do
not attach observers. Failed attachments can be retried by a later active reconciliation.
Reconciliation respects the paused queue and `permissions.execute`; it does not grant permission.

## Dashboard

Run the read-only dashboard against a repository with an installed, loaded factory plugin:

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
Installing the dashboard into another repo is still part of F01; these commands run the source
available in this checkout, not a published package.

### Pipeline view

Build the pipeline page in the repository served by `--repo` before starting the dashboard:

```sh
bun run web:build
amp orb service start factory-dashboard --command 'bun factory/dashboard.ts' --port 4310 --portal
```

The same service serves `web/dist/index.html` at `/` and `/index.html`, generated files under
`/assets/`, and the unchanged read-only `/api/status`. No Vite server, relay, cross-orb proxy, or
sign-in cookie refresh is needed. Restart the service after rebuilding. Without a build, the
existing activity page remains available.

For frontend development, `amp orb services ensure` starts the recorded replay and Vite services
from `.amp/services.yaml`. That preview is labeled recorded data, not a live factory. To develop
against a local dashboard, run `bun run web`; `FACTORY_API` overrides its default API proxy target
`http://127.0.0.1:4310`. The built page always reads `/api/status` on its own origin.

Motion is derived by comparing consecutive polls: a ticket that becomes accepted plays the landing
(packet, press, screen shake, cold review, new commit on main), one that becomes blocked sends a
red packet back to its builder, and a queued one that starts work gets a brief from the foreman
layer through the hand-off. The dashed lane from the return loop up to the foreman is a
placeholder that only the replay button animates. Stale observations stop all motion. Append
`?demo` for labeled sample data.
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
inferred from its single feed status, and a box that expands the gate pill into the integrator's
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
entry. Public titles use ticket IDs, with a delivery label for post-graft reviews. Private briefs
and native thread titles are not public title sources. HTTP ignores observed titles, including
matching fresh or stale legacy observations, without rewriting historical files. Activity remains
an observation: `observedAt` is never advanced by an HTTP read.
`fresh` requires an observation less than 20 seconds old and no more than five seconds in the
future.
Missing, invalid, or stale observations cannot advertise working agents. Activity must also match
the durable thread and revision; observations alone cannot accept work or introduce tickets.
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
Each task adds `evidence`: an `acceptance` revision when done, and `gate`/`review` references only
when a bound review record exists. References include revision, base, and post-graft stage; review
also includes attempt, pending state, and the available reviewer thread. An absent reference is
`null`, not an inferred success. Legacy gate-only acceptance has no retained gate reference.
Private report/log paths, commands, requirements, verdict contents, worker rationale, configuration,
and event details are not served. Review titles omit paths, including in older observation files.
Only the selected HTML, built assets, and GET `/api/status` are served. Source files, private
factory files, other paths, and write methods are rejected.
No model call is used for observation, HTTP reads, or rendering.

**Sample preview** switches to clearly labeled illustrative data. It never starts workers or
modifies the repository. The selector exercises working, blocked, idle, disconnected, and empty
states. **Pause motion** affects visuals only, not the factory. Reduced-motion preferences disable
looping movement. **Back up now** is intentionally disabled until its backend is implemented.

The current screen shows ticket IDs and review labels, available thread links, and accepted revision
hashes. PR metadata, conversation history, and evidence browsing remain backlog work.

## Checks

```sh
bun install --frozen-lockfile
bun run lint:ci
bun run typecheck
bun run format:check
bun test
bun run fallow:ci
```

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
