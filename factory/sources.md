# Where the scout looks for work

In this order. Stop when the queue is full.

1. Failing or skipped tests, and `TODO` / `FIXME` comments in `src/`.
2. Exported functions in `src/` with no test for an edge case (empty input, unicode, limits).
3. Type holes: `any`, non-null `!`, unchecked casts.
4. Docs that disagree with the code.

A good task fits in one commit and names a command that fails today.
