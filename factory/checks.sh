#!/usr/bin/env bash
# Project-owned checks. The factory calls `checks.sh <stage> [base-ref]` from
# the worktree under test. Replace the stage bodies to fit another project.
set -euo pipefail

guard() {
  local bad=0
  git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- . ':!factory' && bad=1
  git grep -nE '\b(test|describe)\.only\(' -- '*.test.ts' && bad=1
  return $bad
}

# ponytail: the cone is "the test file next to each changed file". Swap in an
# import-graph query when a change can break a test that lives elsewhere often
# enough that the post-push full gate gets noisy.
touched_tests() { # base-ref -> test paths, one per line
  git diff --name-only "$1"...HEAD -- 'src/*.ts' |
    sed -E 's/(\.test)?\.ts$/.test.ts/' | sort -u |
    while read -r f; do [ -f "$f" ] && echo "./$f"; done
}

bun install --frozen-lockfile --silent

case "$1" in
  compile) bunx tsc --noEmit ;;
  fmt) bunx prettier --write --log-level warn . ;;
  guard) guard ;;
  test)
    tests=$(touched_tests "$2")
    [ -z "$tests" ] || bun test $tests
    ;;
  full)
    bunx tsc --noEmit
    bunx prettier --check --log-level warn .
    guard
    bun test
    ;;
  *)
    echo "unknown stage: $1" >&2
    exit 2
    ;;
esac
