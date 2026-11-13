# Story: choose worker model and reasoning effort explicitly

Status: locally verified, 2026-11-13. Backend tool configuration under F01 and F03 in
[the backlog](../../backlog.md). Depends on [feature 01](../feature-01/feature-01-story.md).

## 1. Set reasoning effort on native workers

**As** the factory operator,
**I want** my chosen model and reasoning effort to reach the worker's Amp agent definition,
**so that** implementation uses Sol 6.1 at medium effort instead of an unverified model default.

1. New setup defaults to `openai/gpt-6.1-sol` and `workerEffort: "medium"`.
2. `--worker-effort` accepts the native Amp effort values. Invalid CLI values fail before setup
   writes files. Invalid persisted values block check and dispatch before a worker is created.
3. Configuration passes the chosen effort through dispatch into `amp.createAgent` as
   `reasoningEffort`, without provider-specific hooks or prompt-based effort instructions.
4. A legacy configuration without `workerEffort` preserves Amp's model default. It is not rewritten.
5. Repeat setup and refresh preserve existing model, effort, permissions, tickets, and runtime
   state.
6. Correction stays on the same worker. Changing settings does not create a replacement worker.
7. CLI and dispatch checks prove default, explicit nondefault, invalid, and missing values. A native
   agent-definition probe confirms the adapter sends the exact configured settings without spawning
   an additional worker.

## Not in this story

- SQLite, backup, service packaging, frontend settings, or arbitrary model capability discovery.
- Changing the model or effort of an existing worker.
- Parallel execution, additional reviewers, or worker retirement.
