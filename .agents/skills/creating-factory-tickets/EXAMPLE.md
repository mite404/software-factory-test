<!-- Layout example, not a filed ticket. Intended local filename: observation-ticket1.md.
Replace every placeholder and recheck paths/commands before authoring a real ticket. -->

# observation-ticket1

## Status

- Goal: show durable acceptance even when live observations are unavailable.
- Initial priority: P0
- Effort: Medium
- Risk: elevated; read-only status crosses the private-state/public-projection boundary.
- Depends on: conditional post-graft review accepted and installed.
- Planned at: `<actual full planning SHA>`, `<actual planning date>`
- Local path: `docs/feats/observation/observation-ticket1.md`

## Why this matters

Operators need to distinguish recorded acceptance from the latest agent activity. A missing
heartbeat must not erase completed work, and reading status must not expose private reports.

## Current state

`factory/dashboard.ts` reads the heartbeat projection; `factory/persistence.ts` owns durable runs.
Before using this example, inspect both and record the current behavior and relevant symbols.

## Approach

Read durable ticket/run identity through existing persistence. Combine it with timestamped live
observations in the existing HTTP projection. Keep the frontend contract and private report files.

## Scope

- In: existing status API, persistence reader, heartbeat projection, their tests and README.
- Out: frontend redesign, because this ticket preserves the existing response contract.
- Out: mutation endpoints and backup/restore, which have separate permission and recovery work.
- Out: coordinator configuration and runtime records; setup failures return to the coordinator.

## Steps

1. **Read durable ticket records**. Add a read-only durable projection and prove it does not
   initialize or alter storage.
2. **Combine identity with freshness**. Combine durable identity with live freshness without
   promoting stale activity to working.
3. **Verify private field exclusion**. Exercise the HTTP boundary and verify private fields never
   enter its response.

Illustrative queue entry, not authorization to change the coordinator queue or dispatch work.
The `steps` values copy the bold labels above in order. The brief retains the full ticket pointer.

```json
[
  {
    "id": "observation-ticket1",
    "brief": "Implement docs/feats/observation/observation-ticket1.md",
    "after": [],
    "steps": [
      "Read durable ticket records",
      "Combine identity with freshness",
      "Verify private field exclusion"
    ]
  }
]
```

Labels are public planned-work descriptions, not evidence of the worker's current step.

## Test plan

- Exercise real SQLite and HTTP with fresh, stale, missing, and corrupt sources.
- Plant a private-field canary; verify it is absent from the response.
- Compare durable state before and after reads; verify it is unchanged.
- Run the full configured gate and the required cold post-graft review on the exact candidate.

## Why this approach?

- Without this structure: heartbeat loss hides durable results; returning raw records leaks data.
- This buys: persistence owns acceptance, observations own activity, and one allowlisted HTTP
  projection owns disclosure. A second state store would create another consistency problem.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/persistence.ts` | Durable boundary | Validated read-only records | Edit |
| `factory/dashboard.ts` | HTTP boundary | Curated status and freshness | Edit |
| `factory/plugin.ts` | Observation producer | Timestamped agent observations | Edit |
| `factory/persistence.test.ts` | Storage proof | Integrity and read-only cases | Edit |
| `factory/dashboard.test.ts` | HTTP proof | Freshness and privacy cases | Edit |
| `factory/native.ts` | Lifecycle exemplar | Acceptance and review ownership | Read |
| `factory/README.md` | Operator contract | Status fields and failure modes | Edit |

Connections: persistence supplies durable identity; the plugin supplies observed activity;
the HTTP boundary combines them. Build order: persistence + tests, HTTP + tests, observation
compatibility, then documentation. Revalidate consumers before changing a shared field.

## Initial state / preflight

Checks below are not run in this example. Fill in the planning SHA and inspect actual repo scripts.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record dispatch revision; explain differences from planning SHA. |
| `git status --short` | Account for existing edits; preserve unrelated work. |
| `git diff --stat <planned-sha>..HEAD -- factory/` | Revalidate any relevant committed drift. |
| `git diff -- factory/` | No unaccounted unstaged implementation changes. |
| `git diff --cached -- factory/` | No unaccounted staged implementation changes. |
| `bun --version` | Installed version supports the repository toolchain. |
| `bun test` | Baseline tests pass; record the actual outcome. |
| `bun run lint:ci` | No strict lint errors. |
| `bun run typecheck` | No type errors. |
| `bun run format:check` | Baseline formatting passes, including tracked config. |
| `bun run fallow:ci` | Required Fallow gate passes without suppressions. |
| `git diff --check` | No whitespace errors. |

Relevant drift requires refreshed scoping, not a reset. Baseline/configuration failures are
coordinator-owned blockers. Do not expand worker edit scope or claim preflight passed without logs.

## Done when

* Durable accepted work remains visible with missing or stale heartbeat data.
* Stale activity is not reported as current work; private-field canary stays absent.
* Reads leave durable state unchanged, including when a source is missing or corrupt.
* The exact clean candidate passes the full gate and required independent post-graft review.
* Changes stay within the agreed edit paths; the original worker retains repair ownership.

## Notes

In paired mode, Linear title is exactly `observation-ticket1`, matching the filename stem and H1.
Save the returned Linear identifier in local metadata only after creation; never invent one.
In local-only mode, create no external issue or fabricated filing metadata.
