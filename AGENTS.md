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
