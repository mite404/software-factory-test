# v1-ticket3

## Status

- Goal: install the factory and dashboard as repeat-safe repository services.
- Initial priority: P0. Effort: Medium. Risk: elevated; setup must not execute project work.
- Depends on: v1-ticket2.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F01. Local only; pending definition acceptance.

## Why this matters

The working dogfood portal currently needs coordinator-specific service commands and paths.

## Current state

`setup-factory.ts` installs and refreshes an adapter; `dashboard.ts` serves a loopback HTTP API. The
repository has no portable installed service contract covering a built frontend and backend.

## Approach

Use the accepted definition and existing Amp supervised services. Install public-safe service
declarations and documented start/check commands without overwriting an app's declarations. Support
the built frontend sharing the API origin; keep Vite optional for development.

## Scope

Include install/check/refresh and service packaging. Exclude starting workers, enabling schedules,
deployments, custom domains, backup credentials, and replacement-orb restore.

## Steps

1. **Package repository runtime services**. Remove source-checkout-specific runtime dependencies.
2. **Preserve existing application declarations**. Refuse conflicts rather than overwriting edits.
3. **Prove two repository installs**. Start authorized disposable services through Amp supervision.

## Test plan

Install in two disposable repos and repeat setup/refresh. Check byte preservation of application
files and runtime state. Check-only performs no writes or model calls. Render one authenticated
portal with same-origin API and verify non-GET requests cannot mutate through the read service.

## Why this approach?

Tracking service declarations makes a new orb reproducible without making setup an execution grant.

## Files You'll Touch

| Path                                                        | Role           | Contains                | Edit or Read |
| ----------------------------------------------------------- | -------------- | ----------------------- | ------------ |
| `factory/setup-factory.ts`, `factory/setup-factory.test.ts` | Installer      | Repeat-safe packaging   | Edit         |
| `factory/dashboard.ts`, `factory/dashboard.test.ts`         | Server         | Same-origin built UI    | Edit         |
| `factory/README.md`                                         | Operator guide | Service start and check | Edit         |
| `.agents/setup`, `.agents/resume`                           | Orb lifecycle  | Existing project setup  | Read         |

Service templates are proposed generated output, not new duplicate authoritative configuration.

## Initial state / preflight

Run the common preflight in `docs/v1-execution.md`; no service packaging checks ran at authoring.

| Command                                     | Expected result / action                               |
| ------------------------------------------- | ------------------------------------------------------ |
| `git rev-parse HEAD`                        | Confirm accepted definition and frontend availability. |
| `git diff --stat 62816cf..HEAD -- factory/` | Inspect installer drift.                               |

## Done when

- [ ] Two repos run through supervised services without factory source edits or app overwrite.
- [ ] Check-only and installation grant no execution, schedule, external ticket, or push permission.
- [ ] Required gates, browser evidence, and cold review pass.
