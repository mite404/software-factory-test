# Story: refresh the installed factory without resetting work

Status: locally verified, 2026-11-13. First backend dogfood ticket under F01 in
[the backlog](../../backlog.md). Requirements come from [PRD R1](../../prd.md) and
[ADR-010](../../adr.md).

## 1. Refresh the repository adapter

**As** the factory operator,
**I want** to install a revised factory adapter into an existing project,
**so that** I can iterate the workflow without losing configuration or accepted work.

1. Initial setup installs the native plugin with execution disabled.
2. Ordinary repeated setup preserves the existing installation.
3. Explicit `--refresh` rebuilds the plugin from the current source and can repair a missing plugin.
4. Refresh preserves `.factory.json`, the configured ticket file, application files, and all runtime
   state byte for byte. It neither starts workers nor changes permissions.
5. Build or validation failure leaves the previous plugin intact and returns a nonzero exit code.
6. `--check` validates installation without writes. Combining check and refresh is rejected.
7. Real installer commands demonstrate these outcomes in two disposable Git repositories.

## Not in this story

- Dashboard packaging, supervised service configuration, and frontend changes.
- SQLite migration, backups, restore, or worker retirement.
- Automatic plugin reload. The operator explicitly reloads the installed plugin after refresh.
- Separate worker orbs. This first dogfood run uses the existing local-worktree adapter.
