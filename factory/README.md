# Factory prototype

The dispatcher uses Bun SQLite persistence and native Amp thread APIs. Private backups, cross-orb
code transfer, worker retirement, and dashboard chat are not implemented. Requirements and remaining
stories live in [the backlog](../docs/backlog.md).

The [Foreman prompt](foreman.md) defines the current sequential orchestration procedure. It is a
reusable prompt, not an automatically installed agent mode or a change to worker instructions.

## Durable coordinator state

The repository Git directory contains `factory/state.sqlite`, with schema version 1. Coordinator
ownership, retained ticket definitions, worker runs, and ordered events live there. Every lifecycle
transition commits its state and event in one short transaction. Worker calls and asynchronous
verification run outside transactions. The existing poteto bookkeeping lock and revision ledger
remain separate and unchanged. Databases and SQLite journals stay inside Git metadata, not commits.

The first mutating lifecycle operation imports validated `state.json` and `events.jsonl` records.
The original files remain intact for recovery. Later operations use SQLite and ignore stale legacy
files. Removing a ticket from the manifest does not discard its claimed worker or accepted evidence.
Ambiguous creation and delivery stay parked instead of creating replacement workers.

Coordinator status reads existing SQLite or validated legacy state without creating runtime files,
initializing the lock store, or migrating. The plugin separately refreshes dashboard observations,
including during status calls. Malformed legacy records, corrupt databases, and unsupported schema
versions fail visibly before dispatch. Initialization does not grant execution permission.

## Worker settings

Fresh setup defaults to `openai/gpt-6.1-sol` with `workerEffort: "medium"`. Choose a model with
`--worker-model` and effort with `--worker-effort`. Supported native Amp effort values are `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Invalid CLI effort fails before setup writes. Invalid saved effort blocks checks and dispatch
before worker creation.

Existing configuration without `workerEffort` keeps Amp's model default and is not rewritten.
Repeated setup and refresh preserve saved model, effort, permissions, tickets, and runtime state.
To change future workers, edit `workerModel` and `workerEffort` in `.factory.json`. These settings
apply only when creating a new worker. Corrections continue on the same worker with its original
settings, not a replacement.

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

`web/` is a Vite page that draws the same `/api/status` feed as an animated pipeline: one SVG,
CSS animations, and a small TypeScript poller. It is read-only and proxies `/api` to the dashboard
service above (`FACTORY_API` overrides the default `http://127.0.0.1:4310`).

```sh
amp orb service start factory-web --command 'bunx vite web' --port 5173 --portal
```

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
review it stays on the wire. The
verify chips tick on a fixed timeline, not live check results.
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
labels, and the generic stage pills otherwise. The live feed has no `steps` yet, so only `?demo`
shows them. Steps that do not fit the row are dropped.

The plugin publishes a sanitized observation file under the target Git directory. Native Amp
state and title subscriptions trigger updates; a five-second heartbeat refreshes observations.
The browser polls the read-only `/api/status` endpoint every five seconds. Observations older than
20 seconds stop activity motion. No model call is used for observation or rendering.

**Sample preview** switches to clearly labeled illustrative data. It never starts workers or
modifies the repository. The selector exercises working, blocked, idle, disconnected, and empty
states. **Pause motion** affects visuals only, not the factory. Reduced-motion preferences disable
looping movement. **Back up now** is intentionally disabled until its backend is implemented.

The current screen shows ticket and thread titles, available thread links, and accepted revision
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
TypeScript over both `src` and `factory`, and a staged-diff Fallow audit. CI additionally rejects
lint warnings, runs Oxlint's compiler diagnostics alongside standalone `tsc`, checks formatting,
runs every test, rejects focused tests and conflict markers, and applies strict whole-project
Fallow checks. Changed-code attribution is restricted to pre-commit; CI does not exempt inherited
findings. Fallow's built-in CI mode runs dead-code, duplication, and health analysis with failure
on findings. Three-occurrence duplication detection follows Yaklabs' configuration.

The locked development dependencies supply Amp's CLI and official plugin types. Tests use a
bookkeeping fixture instead of requiring a personal Amp skill installation; factory Git operations,
SQLite persistence, verification commands, and installer bundling remain real. This suite does not
prove the external poteto store's cross-process lock or a live authenticated Amp dispatch.

The API check uses a disposable Git repo and real HTTP requests. It covers fresh and stale
observations, field filtering, malformed input, and rejection of file access and mutation requests.
Native dispatch tests use real Git worktrees and configured verification commands, replacing remote
thread operations and external bookkeeping. Live native trials and browser checks are separate
evidence.
