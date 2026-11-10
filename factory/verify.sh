#!/usr/bin/env bash
# Exit predicate for one factory run: `verify.sh <task-id>` exits 0 only if the
# task really landed. Every assertion reads origin, never the local checkout.
set -euo pipefail

ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
F=${FACTORY_HOME:-$ROOT.factory}
id=${1:?usage: verify.sh <task-id>}
task=$F/tasks/landed/$id.md

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok: $*"; }

[ -f "$task" ] || fail "$id is not in landed/"
sha=$(sed -n '1,/^---$/s/^landed: //p' "$task")
[ -n "$sha" ] || fail "$id has no landed sha"
done_when=$(sed -n '/^## Done when/,/^## /p' "$task" | grep -o '`[^`]*`' | head -1 | tr -d '`')
[ -n "$done_when" ] || fail "$id has no Done when command"
ok "$id is landed at ${sha:0:9}, done when: $done_when"

clone=$(mktemp -d)
trap 'rm -rf "$clone"' EXIT
git clone -q "$(git -C "$ROOT" remote get-url origin)" "$clone"
cd "$clone"

git merge-base --is-ancestor "$sha" origin/main || fail "origin/main does not contain $sha"
[ "$(git rev-list --parents -n1 "$sha" | wc -w)" = 3 ] || fail "$sha is not a merge commit"
git log -1 --format=%s "$sha" | grep -q "task/$id" || fail "$sha does not name task/$id"
ok "origin/main contains the merge commit for task/$id"

[ -n "$(git diff --name-only "$sha^1" "$sha" -- src)" ] || fail "the landing changed nothing in src/"
ok "the landing changed: $(git diff --name-only "$sha^1" "$sha" | tr '\n' ' ')"

git merge-base --is-ancestor "$sha" origin/main-green || fail "origin/main-green does not contain $sha"
ok "origin/main-green contains $sha"

git checkout -q "$sha^1"
bun install --frozen-lockfile --silent
! bash -c "$done_when" >/dev/null 2>&1 || fail "Done when already passed before the landing"
ok "Done when fails on the parent of the landing"

git checkout -q origin/main
bun install --frozen-lockfile --silent
bash -c "$done_when" >/dev/null 2>&1 || fail "Done when fails on origin/main"
bash factory/checks.sh full >/dev/null 2>&1 || fail "full gate fails on origin/main"
ok "Done when and the full gate pass on a fresh clone of origin/main"

echo "VERIFIED $id"
