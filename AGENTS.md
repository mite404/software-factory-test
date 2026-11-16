# Agent instructions

These rules apply to every agent that commits in this repository, including the Foreman, factory
workers, and reviewers.

## Mark Amp-generated code

GitHub shows `ampagent` as a co-author only when a commit message ends with the co-author trailer.
The operator uses that to tell Amp-assisted work from work written alone.

- End the message of every commit that contains Amp-generated code with these two trailers, after a
  blank line. Use your own thread URL.

  ```text
  Amp-Thread-ID: https://ampcode.com/threads/<your thread ID>
  Co-authored-by: Amp <amp@ampcode.com>
  ```

- Amp adds both trailers automatically in some threads and not in others. Factory worker commits
  have been observed without them. After each commit, run `git log -1 --format=%B` and amend your
  own unpublished commit if either trailer is missing.
- Do not change the author or committer identity. Do not add the trailers to a commit a person wrote
  alone.
- Merge an Amp-assisted pull request with a merge commit, not a squash, so its co-authored commits
  survive. End the merge commit message with the `Co-authored-by` trailer too.

## Land changes through a green pull request

- Put the change on its own branch, run the full local gate from
  [factory/README.md](factory/README.md#checks) on the branch head, then open a pull request.
- Merge only when every check on the pull request's exact head commit has succeeded. A pending,
  cancelled, or skipped check is not green. Rerun a cancelled check and wait for its result.
- Do not push to `main` directly unless the operator asks for that specific push. Never push the
  same commit to `main` and to an open pull request branch: the two CI runs cancel each other and
  GitHub marks the pull request merged before its check finishes.

## Repeat mistakes and what enforces each rule

Cold review rejected these classes at least twice across factory tickets. A rule enforced only by
review costs a full attempt each time it is missed; move it up a row's level when you can.

| Rule | Past mistakes | Enforced by |
| --- | --- | --- |
| Markdown prose lines stay at or under 100 columns. | F008 a1, watchdog-ticket1 a1 | `factory/checks.sh guard` |
| Record a fact where it happens; never infer it later from a missing file, a read-time clock or a log tail. | F003 a1-a2, F008 a1, F015 a1-a3 | Review only |
| Every path into a state goes through the one function that checks it; do not add a second entry with its own checks. | F003 a1, F030 a1, planned-intake a1, watchdog-ticket3 a2-a3 | Review only |
| Code against an external tool's observed contract (`tool_describe` or a recorded live reply), and make fixtures copy that shape. | watchdog-ticket3 a1-a2, F015 brief, F005 brief | Review only |
| A reconcile with nothing new writes no event, incident or remote effect. | watchdog-ticket1 a1, F003 a2, watchdog-ticket3 a3 | Review only |
| Update every doc, comment and guidance file that the change makes false. | F013 a1, F024 a1, watchdog-ticket3 a1 | Review only |
| Derive test expectations from the spec, not from the code under test. | F003 a1, F018 a2, watchdog-ticket3 a2 | Review only |
