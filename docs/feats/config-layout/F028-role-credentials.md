# F028-role-credentials

## Status

- Goal: each factory role can reach only the credentials its own config file names, and a
  worker cannot push even if its instructions are ignored.
- Outcome: Each role sees only its own credentials
- Initial priority: P3. Effort: Large.
- Risk: high; it changes the environment every worker and reviewer runs in. A missing credential
  stops work; an extra one is the bug this ticket exists to remove.
- Depends on: F025-config-directory. Placed last in the order by the operator.
- Planned at: `0ccad909da953187ec58ca6011965b9e7db3cceb`, 2026-11-15. Local only.

## Why this matters

Workers and reviewers run on the `factory-dogfood` runner inside the operator's orb, which is
signed in to GitHub. "Workers never push" is a sentence in the brief; `permissions.publish:
false` stops no `git push`. That is acceptable while the operator owns all intake. It stops
being acceptable once outside input can start work (hooks in v1-ticket12, intake in F17) or
someone else runs the factory.

## Current state

- `gh auth status` in the orb reports an active GitHub account; the runner shares that orb.
- The definition has no secrets or credentials field. `permissions` has four factory-wide
  booleans.
- Only the Foreman's integration step needs to push and open pull requests.

## Approach

Deny by default, grant by name, and enforce in the environment rather than the prompt.

- Each `factory/config/agents/<role>/agent.md` gains `secrets: [NAME, ...]`: names only, never
  values. No list means none. The Foreman's integration step is the only place push credentials
  are named.
- The worker and reviewer launch environment is built from that list: inherited Git and GitHub
  credentials are removed (credential helper, `GH_TOKEN`, `GITHUB_TOKEN`, `gh` config), and only
  named secrets are set.
- `--effective` shows each role's secret names and never values.

## Scope

- In: the `secrets` field, the launch environment, a push refusal proof, `--effective`, README.
- Out: network egress policy, per-role tool servers, and cloud identities. Add each when a role
  first needs it.

## Steps

1. **Prove push today**. From a fixture worker environment, show that `git push` to a local bare
   remote with a credential helper succeeds today.
2. **Declare role secrets**. Add `secrets` to the agent schema and the effective view, names
   only.
3. **Strip inherited credentials**. Build worker and reviewer environments without inherited
   Git and GitHub credentials, plus the named secrets.
4. **Prove push refused**. Rerun step 1's fixture and show the push fails for lack of
   credentials while a named secret is present.
5. **Document role secrets**. Describe the field, the stripped variables and the threat model.

## Test plan

- Step 1 and step 4 fixtures, run on the same remote, before and after.
- A secret value never appears in `--effective`, `/api/definition` or the feed: plant a canary.
- An unknown secret name is refused at load.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: any worker that follows an injected instruction can push with the operator's
  identity.
- This buys: the limit lives in the environment, where an instruction cannot change it, and each
  role's reach is readable in its own file.

## Files You'll Touch

| Path                       | Role              | Contains                      | Edit or Read |
| -------------------------- | ----------------- | ----------------------------- | ------------ |
| `factory/native.ts`        | Loader, launcher  | `secrets` field, environment  | Edit         |
| `factory/executor.ts`      | Worker launch     | Environment passed to workers | Edit         |
| `factory/setup-factory.ts` | Effective view    | Secret names per role         | Edit         |
| `factory/native.test.ts`   | Proof             | Push before/after, canary     | Edit         |
| `factory/README.md`        | Operator contract | Role secrets, threat model    | Edit         |

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                | Expected result / action                               |
| -------------------------------------- | ------------------------------------------------------ |
| `git rev-parse HEAD`                   | Record it; explain differences from the planning SHA.  |
| `ls factory/config/agents`             | Present; F025 has landed.                              |
| `rg -n "env" factory/executor.ts`      | Find where the launch environment is built, if at all. |
| `bun test factory`                     | Baseline passes; record the outcome.                   |
| `bun run lint:ci && bun run typecheck` | No errors.                                             |
| `bash factory/checks.sh guard`         | Pass.                                                  |

If the runner's environment cannot be controlled from the factory (the runner process owns it),
return to the Foreman with that evidence; do not widen scope to change runner supervision.

## Done when

- [ ] A worker environment cannot push, proven before and after on one fixture.
- [ ] Each role receives only the secrets its file names, and values never appear in any view.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.
