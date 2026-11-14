# v1-ticket2

## Status

- Goal: resolve one versioned project-owned definition without implicit execution.
- Initial priority: P0. Effort: Medium. Risk: elevated; configuration controls permissions and runs.
- Depends on: canonical Feature 05 adoption.
- Planned at: `62816cf8a6c8c282172754c4a97242e5a4a9eab1`, 2026-11-13.
- Backlog: F12. Local only; pending dependency acceptance.

## Why this matters

Projects need different commands and roles without forking the factory or maintaining two settings.

## Current state

`configuration` reads `.factory.json`; setup bundles a plugin and preserves existing configuration.
R15 requires YAML operations, Markdown instructions, and JSON schemas with one home per setting.

## Approach

Define the supported schema and one effective configuration consumed by backend and dashboard. Add
explicit migration from existing JSON, read-only validation, and a secret-free effective view. Pin
the definition digest to new runs; reload affects future work, never active scope or gates.

## Scope

Include definition loading, schema, migration, setup and run pinning. Exclude hooks, service
packaging, discovery execution, new remote permissions, and automatic migration on ordinary reads.
Expected edits are `factory/` and a proposed project definition/schema path chosen in this unit.

## Steps

1. **Define authoritative project settings**. Map every existing setting once into a versioned
   schema.
2. **Migrate only on request**. Preserve project edits, private boundaries, and explicit
   permissions.
3. **Pin future run definitions**. Validate reload while an older worker retains its original scope.

## Test plan

Use two real disposable repositories with distinct settings. Reject bad versions, references,
unsupported capabilities, and unsafe paths with no command execution or database mutation. Prove
repeat migration, no silent permission expansion, and unchanged active-worker requirements.

## Why this approach?

Independent YAML and JSON copies would disagree. One resolver keeps the UI and execution truthful.

## Files You'll Touch

| Path                                            | Role          | Contains                            | Edit or Read |
| ----------------------------------------------- | ------------- | ----------------------------------- | ------------ |
| `factory/native.ts`, `factory/setup-factory.ts` | Configuration | Legacy loader and install           | Edit         |
| `factory/persistence.ts`                        | Durable runs  | Definition pinning                  | Edit         |
| `factory/dashboard.ts`, `factory/plugin.ts`     | Consumers     | Effective capabilities              | Edit         |
| `factory/*.test.ts`                             | Proof         | Migration and no-side-effect checks | Edit         |
| `docs/prd.md`, `docs/adr.md`                    | Requirements  | R15 and decisions                   | Read         |

Build schema/resolver before migration and consumers. List proposed files in the candidate report.

## Initial state / preflight

Execute `docs/v1-execution.md` dispatch preflight; authoring did not run implementation checks.

| Command                                     | Expected result / action               |
| ------------------------------------------- | -------------------------------------- |
| `git rev-parse HEAD`                        | Record accepted backup prerequisite.   |
| `git diff --stat 62816cf..HEAD -- factory/` | Revalidate all settings and consumers. |

## Done when

- [ ] Two projects use one validated authoritative definition with no engine fork.
- [ ] Checks and normal reads execute nothing; migration and reload preserve active ownership.
- [ ] Full gates and fresh required cold review pass on the exact revision.
