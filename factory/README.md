# Factory prototype

The current dispatcher uses file persistence and native Amp thread APIs. SQLite, private backups,
cross-orb code transfer, worker retirement, and dashboard chat are not implemented. Requirements and
remaining stories live in [the backlog](../docs/backlog.md).

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
bun test
```

The API check uses a disposable Git repo and real HTTP requests. It covers fresh and stale
observations, field filtering, malformed input, and rejection of file access and mutation requests.
Native dispatch tests use real Git worktrees and configured verification commands, replacing only
remote thread operations. Live native trials and browser verification are separate evidence.
