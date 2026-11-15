# Feature 07: expose durable observation evidence

Implement `feature-07-story.md`, the next eligible P0 slice of backlog F07. This does not implement
backup, restore, chat, mutation endpoints, or a dashboard redesign. Scope Medium, elevated risk:
read-only privacy and freshness are the safety boundaries. Set `size: "medium"` and `risky: true`
when enqueuing; the new adapter must require a cold post-graft review.

Start at `factory/dashboard.ts`, `factory/plugin.ts`, and `factory/persistence.ts`. The HTTP service
currently trusts `dashboard.json`; persistence already stores tickets/runs/events transactionally.
Reuse that schema and existing validation rather than introducing another store or query service.
Keep native thread observations in the heartbeat projection; reading SQLite must not freshen them.
Prefer an additive, backward-compatible response and the existing frontend. Gate/review reference
metadata can be returned without making private reports downloadable.

Allowed implementation: those three existing modules, their tests, and `factory/README.md`.
Only adjust `factory/native.ts` if recording an existing acceptance fact is genuinely necessary.
No dependencies, generated files, parent edits, queue/config edits, remote writes, or nested agents.
The parent owns scoping and runs the generated adapter; this worker owns implementation and proof.

Write a failing HTTP regression for the stale/missing heartbeat hiding durable acceptance. Exercise
real Git/SQLite/server boundaries. Include privacy and read-only negative controls. Run the full
configured test, strict lint, types, formatting, Fallow, and whitespace gates without suppressions.
Save full outputs under the Git factory directory and submit the exact clean committed candidate
through the factory report protocol. Return concise results and evidence paths.

## Why this approach?

Without a durable reader, a lost heartbeat hides completed work. Returning raw state instead would
expose private coordinator details. Keep acceptance in SQLite, live activity in observations, and
disclosure in one allowlisted HTTP projection. A second database or event service adds drift.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/persistence.ts` | Durable boundary | Validated read-only records | Edit |
| `factory/dashboard.ts` | HTTP boundary | Curated status and freshness | Edit |
| `factory/plugin.ts` | Observation producer | Timestamped agent activity | Edit |
| `factory/persistence.test.ts` | Storage proof | Integrity and no-write cases | Edit |
| `factory/dashboard.test.ts` | HTTP proof | Freshness and privacy cases | Edit |
| `factory/plugin.test.ts` | Observation proof | Producer/consumer compatibility | Edit |
| `factory/native.ts` | Lifecycle owner | Acceptance and review evidence | Read by default |
| `factory/README.md` | Operator contract | Status behavior and limitations | Edit |

Connections: persistence owns durable identity, the plugin owns observed activity, and the HTTP
boundary combines them. Build leaf-first: durable reader/tests, HTTP/tests, producer compatibility,
then README. The narrow native.ts exception above requires evidence that an existing fact is absent.

## Initial state / preflight

Planning code baseline: `cd75e02d27d3122ff812acf1333ee1bfae228625`, 2026-11-13. The factory's full
gate passed for this accepted review-feature revision. Dispatch pins the later coordinator setup
commit containing this ticket/config; verify relevant code is unchanged from the planning baseline.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record actual dispatch base. |
| `git status --short` | Clean worker checkout before implementation. |
| `git diff --stat cd75e02..HEAD -- factory/` | No unexplained code drift. |
| `git diff -- factory/` | No unaccounted unstaged changes. |
| `git diff --cached -- factory/` | No unaccounted staged changes. |
| `bun --version` | Repository toolchain is available. |
| `bun test` | Baseline test suite passes. |
| `bun run lint:ci` | Strict lint passes. |
| `bun run typecheck` | Types pass. |
| `bun run format:check` | Formatting, including tracked config, passes. |
| `bun run fallow:ci` | Required Fallow gate passes without suppressions. |
| `git diff --check` | No whitespace errors. |

Record preflight results, not inferred green. Revalidate drift and preserve unrelated work.
Baseline/configuration failures return to the coordinator; do not widen worker scope.

## Done when

* All story criteria are exercised through real HTTP/SQLite, including privacy and no-write cases.
* The exact clean candidate passes the complete configured gate and required cold post-graft review.
* Existing frontend fields remain compatible; missing evidence stays absent rather than invented.
* The original worker retains repair ownership and no private report contents are served.
