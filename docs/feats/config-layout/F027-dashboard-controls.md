# F027-dashboard-controls

## Status

- Goal: the operator can turn automations on and off and run one now from the dashboard, and
  see each automation's schedule and last run.
- Outcome: The dashboard switches and runs automations
- Initial priority: P2. Effort: Medium.
- Risk: high; the dashboard server is read-only today and is reachable through an Amp portal. The
  first write endpoint must refuse anyone but the operator and must not let a page trick a
  browser into posting.
- Depends on: F026-factory-automations.
- Planned at: `0ccad909da953187ec58ca6011965b9e7db3cceb`, 2026-11-15. Local only.

## Why this matters

The operator wants to steer automations from the page they already watch, without opening the
Foreman thread. The dashboard currently answers every non-GET request with 405.

## Current state

- `factory/dashboard.ts` serves `web/dist`, `/api/status` and `/api/definition` on 127.0.0.1 and
  refuses every method but GET.
- The page is reached through an Amp portal, which requires an Amp sign-in. Whether the portal
  forwards the signed-in user's identity to the server is not known.
- The dashboard process has no Amp tools; only the plugin in a connected owner turn can send
  prompts or change schedules.

## Approach

The dashboard records requests; the plugin carries them out.

- `POST /api/automations/<name>` with `{ "action": "enable" | "disable" | "run" }` writes one row
  to a SQLite request table and returns 202. It never sends a prompt or touches a schedule.
- On the next connected owner wake or reconcile, the plugin applies pending requests through the
  same code paths as F026's control actions, oldest first, and marks each `applied` or
  `refused` with a reason. A request older than one hour is refused, not applied.
- Authorization: require a per-factory token stored in `.git/factory/` (created at setup,
  never published) in an `authorization` header, and an exact `origin` match. The page reads the
  token from a same-origin `GET /api/control-token` that answers only requests carrying the
  portal's own headers; if preflight shows the portal forwards no usable identity, ship the
  token as an operator-pasted value in local storage instead and say so in the README.
- `/api/status` gains an `automations` list: name, schedule, enabled, last run time and outcome,
  and pending requests. No prompt bodies.
- UI: one row per automation in the existing kit page style with a switch, a run button and the
  last run. A pending request shows as pending until applied or refused.

## Scope

- In: the request table, the POST endpoint with authorization, the plugin apply step, the status
  fields, one dashboard section, tests and README.
- Out: editing prompts or schedules from the page, controls for tickets (admit, pause, start),
  and live traces. F013 owns the event log view.
- Preserve: every existing GET response and the read-only behaviour of all other paths.

## Steps

1. **Check portal identity**. Record what headers the portal forwards and choose the token
   delivery accordingly, before any code.
2. **Record dashboard requests**. Add the request table and the authorized POST endpoint that
   only writes a row.
3. **Apply requests from plugin**. Apply pending requests on owner wakes through F026's action
   code, refusing stale ones.
4. **Publish automation state**. Add automation rows and pending requests to `/api/status`
   without prompt bodies.
5. **Draw automation controls**. Add the automation section to the kit page and verify it in
   screenshots for on, off, pending and refused.

## Test plan

- A POST without the token, with a wrong token, or from another origin returns 401 or 403 and
  writes nothing.
- A valid POST writes one row and changes no schedule and sends nothing.
- The plugin applies `run` once even when reconciled twice; a two-hour-old request is refused.
- `/api/status` never contains a prompt body: plant a canary in an automation body.
- Every other path still refuses non-GET methods.
- Screenshots of the section in each state at 1440 and 390 px.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: the dashboard would need Amp tools it does not have, or would act outside the
  owner's connected turn, where no permission check runs.
- This buys: the dashboard can only ask; the owner's plugin decides with the same checks as a
  control call, so the page adds no new way to start work.

## Files You'll Touch

| Path                        | Role           | Contains                            | Edit or Read |
| --------------------------- | -------------- | ----------------------------------- | ------------ |
| `factory/dashboard.ts`      | HTTP boundary  | POST endpoint, token, status fields | Edit         |
| `factory/persistence.ts`    | Durable state  | Request table                       | Edit         |
| `factory/plugin.ts`         | Apply step     | Pending requests on owner wakes     | Edit         |
| `factory/dashboard.test.ts` | HTTP proof     | Auth, write-only, canary            | Edit         |
| `factory/plugin.test.ts`    | Apply proof    | Once-only, stale refusal            | Edit         |
| `web/`                      | Kit page       | Automation section                  | Edit         |
| `factory/README.md`         | Operator guide | Controls, token, threat model       | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                     | Expected result / action                              |
| ------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                        | Record it; explain differences from the planning SHA. |
| `git status --short`                        | Clean, or every edit accounted for.                   |
| `rg -n "automation-run" factory/plugin.ts`  | Present; F026 has landed.                             |
| `bun test factory`                          | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`      | No errors.                                            |
| `bun run format:check && bun run fallow:ci` | Pass.                                                 |
| `bun run web:build`                         | Builds.                                               |
| `bash factory/checks.sh guard`              | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] The dashboard turns an automation on or off and runs it, applied on the next owner wake.
- [ ] Unauthorized or cross-origin posts are refused and write nothing.
- [ ] Requests apply once, and stale requests are refused with a visible reason.
- [ ] The page shows each automation's schedule, state and last run, verified in screenshots.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
