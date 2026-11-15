# F025-config-directory

## Status

- Goal: the factory loads its definition from a `factory/config/` directory with one file per
  concern, so each agent and runner has its own file to read, version and limit.
- Outcome: Factory settings live in one file per concern
- Initial priority: P1. Effort: Medium.
- Risk: elevated; the definition loader decides permissions, scope and the pinned digest. A
  loader that reads a file it does not validate, or misses a file in the digest, lets a setting
  change without a reload.
- Depends on: nothing. Later tickets add `checks/`, `scorers/`, `benchmarks/` and
  `automations/` to this directory, and move the worker and reviewer prompts into it.
- Planned at: `5fbb1604d8160444cb5346fceaf31bf0cb54e6f0`, 2026-11-15. Local only.

## Why this matters

The operator wants the factory configured the way Warp's factories are: a directory of small
files, one per agent, runner, check and trigger. Today one flat object holds identity, three
roles' models, the runner, setup, verification, permissions and backup, and its schema has no
place for a second agent or runner. The reviewer is one boolean; a project cannot see or version
what the reviewer is. The comparison is in the thread artifact "Factory config as code".

## Current state

- `configuration` in `factory/native.ts` reads `factory/definition.yaml` or legacy
  `.factory.json`, refuses both together, validates against `factory/definition.schema.json`
  (`additionalProperties: false`), and hashes the file bytes plus the `prd` instructions into
  the digest.
- `migrateDefinition` moves `.factory.json` to `factory/definition.yaml` byte for byte.
- `allowedScope` and the changed-path check refuse `factory/definition.yaml` as a worker edit.
- Roles are top-level values: `workerModel`, `workerEffort`, `workerRunner`,
  `orchestratorModel`, `review`. `reviewerModel` in `factory/native.ts` picks the reviewer from
  the worker's provider. `setup` and `setupTimeoutMs` sit beside them.
- `factory/foreman.md` is the Foreman prompt. The engine does not load it.
- The dogfood project uses `.factory.json`. No project uses `factory/definition.yaml`.

## Approach

Add the directory as a third definition source and compose it into the same validated object
the engine already uses, so nothing downstream of `configuration` changes.

```text
factory/config/
  factory.yaml                  version, capacity, mode, prd, tickets, scope, verify,
                                permissions, backup, bookkeepingSHA256, watchdog
  agents/foreman/agent.md       front matter: model. Body: today's factory/foreman.md
  agents/implementer/agent.md   front matter: model, effort, runner
  agents/reviewer/agent.md      front matter only; the file's presence turns review on
  runners/<name>.yaml           setup, setupTimeoutMs; <name> is the runner ID
```

- A resource's name is its path. `agents/implementer/agent.md` names a runner; that
  `runners/<name>.yaml` must exist. This is the first cross-reference check.
- Agent files are Markdown with YAML front matter, parsed with `Bun.YAML.parse`.
- Every file gets a schema that rejects unknown keys. An unknown file or directory under
  `factory/config/` is an error, not ignored.
- The digest covers every file under `factory/config/`, in sorted path order with each path
  mixed in, plus the `prd` instructions.
- The implementer and reviewer bodies must be empty in this ticket, because nothing reads them
  yet. A setting with no reader is refused, not stored.
- `--migrate` writes the directory from either flat file and removes the flat file. Flat files
  stay readable. The directory together with a flat file is a conflict.
- Workers may not edit anything under `factory/config/`.

## Scope

- In: the loader, per-file schemas, digest, migration, the scope refusal, moving `foreman.md`,
  their tests and the README.
- Out: `checks/`, `scorers/`, `benchmarks/`, `automations/`, `webhooks/`, `routers/`, `skills/`.
- Out: per-agent secrets, tool servers, network policy and per-role permissions. Add a field
  when a role first needs one.
- Out: a reviewer model setting and loading worker or reviewer prompts from files.
- Preserve: flat-file projects load to the same effective settings as today; `publish` and
  `externalTickets` stay refused by schema; reload stays explicit.

## Steps

1. **Compose the directory definition**. Read `factory/config/` into the object
   `validateConfiguration` accepts today, with a schema per file that rejects unknown keys and
   unknown files.
2. **Check runner references**. Refuse an agent that names a runner with no
   `runners/<name>.yaml`, and a runner file no agent names.
3. **Digest every config file**. Hash all files under the directory in sorted order so a change
   to any one changes the digest, and prove an unreloaded edit does not change an active run.
4. **Refuse worker config edits**. Extend `allowedScope` and the changed-path check from
   `factory/definition.yaml` to everything under `factory/config/`.
5. **Migrate flat definitions**. Make `--migrate` write the directory from `.factory.json` or
   `factory/definition.yaml`, repeatably, refusing to overwrite an existing directory.
6. **Move the Foreman prompt**. Move `factory/foreman.md` to
   `factory/config/agents/foreman/agent.md` and update every reference.
7. **Document the layout**. Replace the README's definition section with the directory layout,
   the conflict rule and the migration command.

## Test plan

- Load the same settings from a flat file and from a directory: the effective views are equal
  apart from the digest.
- Each of these is refused with a message naming the file: an unknown key, an unknown file, a
  missing `factory.yaml`, an agent naming an absent runner, a non-empty implementer body,
  `publish: true`, a directory beside a flat file.
- Change one byte in each config file in turn: the digest changes every time.
- A candidate that edits `factory/config/runners/x.yaml` is rejected by the changed-path check
  even with `factory/` in scope.
- Migrate a copy of the dogfood `.factory.json`, then migrate again: same files, no error, and
  `--effective` matches the pre-migration view apart from the digest.
- An interrupted migration (directory partly written) is refused or completed, never loaded
  half-written.
- Full configured gate, `bash factory/checks.sh guard`, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null bun test factory`.

## Why this approach?

- Without it: every later category (checks, scorers, hooks, a second runner) adds more
  unrelated keys to one object, and role limits have nowhere to live except prompt text. Warp's
  docs put the rule plainly: what an agent can reach comes from its configuration, never from
  its instructions.
- This buys: one owner per file, and a loader that is the only place the layout is known. The
  engine keeps consuming one validated object, so the change cannot alter run behaviour, and
  the pinned digest still covers every setting.

## Files You'll Touch

| Path                                     | Role              | Contains                                             | Edit or Read |
| ---------------------------------------- | ----------------- | ---------------------------------------------------- | ------------ |
| `factory/native.ts`                      | Loader            | `configuration`, `migrateDefinition`, `allowedScope` | Edit         |
| `factory/definition.schema.json`         | Flat schema       | The object the loader composes                       | Read or Edit |
| `factory/config.schema.json`             | Per-file schemas  | `factory`, `agent`, `runner`                         | Create       |
| `factory/setup-factory.ts`               | Setup tool        | `--migrate`, `--check`, `--effective`                | Edit         |
| `factory/native.test.ts`                 | Loader proof      | Compose, refuse, digest, scope                       | Edit         |
| `factory/setup-factory.test.ts`          | Migration proof   | Migrate, repeat, interrupted                         | Edit         |
| `factory/config/agents/foreman/agent.md` | Foreman prompt    | Moved from `factory/foreman.md`                      | Create       |
| `factory/foreman.md`                     | Foreman prompt    | Removed after the move                               | Edit         |
| `factory/README.md`                      | Operator contract | Layout, conflict rule, migration                     | Edit         |
| `.factory.json`                          | Dogfood setup     | Migrated by the Foreman after landing                | Coordinator  |

Build order: schemas and the composing loader with tests, the reference check, the digest, the
scope refusal, migration, the prompt move, the README. The dogfood project is migrated by the
Foreman after this lands, not by the worker.

## Initial state / preflight

Checks below were not run when this ticket was written.

| Command                                           | Expected result / action                              |
| ------------------------------------------------- | ----------------------------------------------------- |
| `git rev-parse HEAD`                              | Record it; explain differences from the planning SHA. |
| `git status --short`                              | Clean, or every edit accounted for.                   |
| `git diff --stat 5fbb160..HEAD -- factory/`       | Revalidate `configuration` and `migrateDefinition`.   |
| `ls factory/config`                               | Absent.                                               |
| `rg -n "foreman.md" --glob '!docs/feats/done/**'` | Lists every reference to update.                      |
| `bun test factory`                                | Baseline passes; record the outcome.                  |
| `bun run lint:ci && bun run typecheck`            | No errors.                                            |
| `bun run format:check && bun run fallow:ci`       | Pass.                                                 |
| `bash factory/checks.sh guard`                    | Pass.                                                 |

A baseline failure goes back to the Foreman; it does not widen the worker's scope.

## Done when

- [ ] A project with only `factory/config/` loads, and its effective settings equal the same
      project's flat-file settings.
- [ ] Unknown keys, unknown files, a dangling runner reference and a directory beside a flat
      file are each refused with the file named.
- [ ] Changing any config file changes the digest, and an active run keeps its pinned settings
      until an explicit reload.
- [ ] A worker candidate that edits any file under `factory/config/` is rejected.
- [ ] `--migrate` produces the directory from a flat file and is safe to repeat.
- [ ] The Foreman prompt lives at `factory/config/agents/foreman/agent.md` and no reference to
      the old path remains outside `docs/feats/done/`.
- [ ] Full gates, guard and a fresh cold review pass on the accepted revision.

## Notes

Field names follow Warp's `v1alpha1` layout where the meaning matches (`agents/<name>/agent.md`,
`runners/<name>.yaml`, name is path). Fields that assume hosted compute or remote intake are not
adopted. `docs/feats/v1/v1-ticket11.md`, `v1-ticket12.md` and `v1-ticket19.md` should place
their declarations under this directory once it lands.
