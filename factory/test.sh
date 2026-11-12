#!/usr/bin/env bash
# Engine check: drives every factory path against a throwaway origin with a
# scripted stub agent, so it runs in a few minutes without calling a model.
# The stub runs the task's "## Stub" section; a main-red task with no stub is
# fixed by reverting its culprit. `KEEP=1 factory/test.sh` keeps the sandbox.
set -euo pipefail

SELF=$(readlink -f "$0")

if [ "${1:-}" = session ]; then
  echo "s-$(date +%s%N)"
  exit 0
fi
if [ "${1:-}" = agent ]; then
  if [ -n "${FACTORY_TASK_FILE:-}" ]; then # a builder, called as: agent <session> <prompt>
    t=$(basename "$FACTORY_TASK_FILE" .md) d=$(dirname "$TRACE")
    echo "$t $2" >>"$d/sessions"
    printf '%s' "$3" >"$d/prompt-$t-$(grep -c "^$t " "$d/sessions")"
  fi
  if [ -z "${FACTORY_TASK_FILE:-}" ]; then # the scout
    factory/dev task add 'add countWords' <<'TASK' >/dev/null
Count the words in a string.

## Done when
`bun test src/words.test.ts` passes.

## Stub
echo "start" >>"$TRACE"
sleep 3
cat >src/words.ts <<'X'
export const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;
X
cat >src/words.test.ts <<'X'
import { expect, test } from "bun:test";
import { countWords } from "./words";
test("counts words", () => expect(countWords(" a  b ")).toBe(2));
X
echo "end" >>"$TRACE"
TASK
  elif grep -q '^## Stub$' "$FACTORY_TASK_FILE"; then
    sed -n '/^## Stub$/,/^## /{/^## /!p}' "$FACTORY_TASK_FILE" | bash
  else
    git revert -m 1 --no-edit "$(sed -n '1,/^---$/s/^culprit: //p' "$FACTORY_TASK_FILE")"
  fi
  exit 0
fi
if [ "${1:-}" = review ]; then
  if grep -q BUG <<<"${*: -1}"; then echo "factory/sources.md: a line says BUG."; else echo LGTM; fi
  exit 0
fi

trap 'echo "FAIL: line $LINENO: $BASH_COMMAND" >&2' ERR
SRC=$(dirname "$(dirname "$SELF")")
tmp=$(mktemp -d)
[ -n "${KEEP:-}" ] && echo "sandbox: $tmp" || trap 'rm -rf "$tmp"' EXIT
R=$tmp/repo
F=$R.factory
unset FACTORY_HOME
export AGENT="bash $SELF agent" REVIEWER="bash $SELF review" TRACE=$tmp/trace
export AGENT_NEW_SESSION="bash $SELF session" AGENT_RESUME="bash $SELF agent {}"
export REVIEWER_RESUME="bash $SELF review {}"
export FACTORY_ATTEMPTS=1 FACTORY_BUILDERS=2 FACTORY_QUEUE=2
export GIT_AUTHOR_NAME=factory GIT_AUTHOR_EMAIL=factory@test GIT_COMMITTER_NAME=factory GIT_COMMITTER_EMAIL=factory@test

ok() { # message command... -> exits on the first failed assertion
  local m=$1
  shift
  "$@" || {
    echo "FAIL: $m" >&2
    [ -z "${KEEP:-}" ] || tail -30 "$F/log/factory.log" >&2
    exit 1
  }
  echo "ok: $m"
}
dev() { "$R/factory/dev" "$@" 2>/dev/null; }
state() { basename "$(dirname "$(ls "$F"/tasks/*/"$1".md)")"; }
meta() { sed -n "1,/^---\$/s/^$2: //p" "$F"/tasks/*/"$1".md; }
id_of() { grep -l "^title: $1\$" "$F"/tasks/*/*.md | xargs -n1 basename | sed 's/\.md$//'; }
main() { git -C "$R" fetch -q origin && git -C "$R" rev-parse origin/main; }
green() { git -C "$R" rev-parse origin/main-green; }
logged() { grep -q "$1" "$F/log/factory.log"; }
sessions_of() { sed -n "s/^$1 //p" "$tmp/sessions"; }
last_prompt() { cat "$(ls -v "$tmp"/prompt-"$1"-* | tail -1)"; }
task() { # title stub-script [task add flags] -> id
  printf 'Test task.\n\n## Done when\n`true` passes.\n\n## Stub\n%s\n' "$2" | dev task add "$1" "${@:3}"
}

git init -q --bare -b main "$tmp/origin.git"
git clone -q "$SRC" "$R"
cp "$SRC"/factory/* "$R/factory/"
git -C "$R" add -A
git -C "$R" commit -qm "test: engine under test" || true
git -C "$R" remote set-url origin "$tmp/origin.git"
git -C "$R" push -q origin HEAD:main HEAD:main-green
cd "$R"

ok "task add rejects a task with no Done when" bash -c '! "$0" task add nothing <<<"no finish line" 2>/dev/null' "$R/factory/dev"

docs=$(task 'add notes' 'echo "start" >>"$TRACE"; sleep 3; mkdir -p docs; echo "# Notes" >docs/notes.md; echo "end" >>"$TRACE"')
git worktree add -q --detach "$F/wt/_scout" origin/main # left by a killed scout
dev run >/dev/null
words=$(id_of 'add countWords')
ok "the scout topped the queue up to FACTORY_QUEUE" [ -n "$words" ]
ok "two builders ran in parallel" [ "$(tr '\n' ' ' <"$TRACE")" = "start start end end " ]
ok "both landed" [ "$(state "$docs") $(state "$words")" = "landed landed" ]
ok "the docs-only diff took the fast lane" logged "$docs lane=fast stages=fmt guard"
ok "the code diff took the normal lane" logged "$words lane=normal"
ok "fmt was applied and committed" [ "$(git -C "$R" show origin/main:src/words.ts | wc -l)" -gt 1 ]
ok "the after-check moved main-green to main" [ "$(green)" = "$(main)" ]
ok "verify.sh accepts the landed code task" bash -c "factory/verify.sh $words | grep -q 'VERIFIED $words'"
ok "verify.sh rejects a landing with no code change" bash -c "! factory/verify.sh $docs >/dev/null 2>&1"

hi=$(task 'add greet' 'echo "export const greet = (n: string): string => \"hi \" + n;" >src/greet.ts')
clash=$(task 'add wave' '
if [ -e "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
  git show origin/main:src/greet.ts >src/greet.ts
  echo "export const wave = (n: string): string => \"hello \" + n;" >>src/greet.ts
else
  echo "export const wave = (n: string): string => \"hello \" + n;" >src/greet.ts
fi')
rename=$(task 'rename MAX_SLUG' 'sed -i s/MAX_SLUG/SLUG_MAX/g src/limits.ts src/slug.ts')
stale=$(task 'add fitsSlug' '
v=MAX_SLUG
! git grep -q SLUG_MAX -- src/limits.ts || v=SLUG_MAX
printf "import { %s } from \"./limits\";\nexport const fitsSlug = (s: string): boolean => s.length <= %s;\n" $v $v >src/title.ts')
for _ in 1 2 3 4; do dev build b1; done
dev integrate
dev drain
ok "the first of two clashing branches landed" [ "$(state "$hi")" = landed ]
ok "the conflict bounced back to its builder" [ "$(state "$clash") $(meta "$clash" owner)" = "ready b1" ]
ok "the bounce names the conflicting file" grep -q 'Conflict with origin/main in: src/greet.ts' "$F/tasks/ready/$clash.md"
ok "a clean merge that breaks compile bounced" grep -q 'Integrator gate failed' "$F/tasks/ready/$stale.md"
ok "the rename landed past the bounces" [ "$(state "$rename")" = landed ]
dev build b1
dev build b1
dev integrate
dev drain
ok "the builder resolved the conflict and it landed" [ "$(state "$clash")" = landed ]
ok "the builder fixed the semantic break and it landed" [ "$(state "$stale")" = landed ]
ok "retried changes were reviewed" logged "$clash review clean"
ok "main is green after the bounces" [ "$(green)" = "$(main)" ]
ok "a bounced task kept one agent session across its attempts" \
  [ "$(sessions_of "$clash" | wc -l) $(sessions_of "$clash" | sort -u | wc -l)" = "2 1" ]
ok "every task got its own session" [ "$(sort -u "$tmp/sessions" | cut -d' ' -f2 | sort | uniq -d)" = "" ]
ok "the resumed session got the failure summary, not the task again" \
  bash -c '[[ $0 == *"error TS"* && $0 == *"Full output: "* && $0 != *"## Done when"* ]]' "$(last_prompt "$stale")"
failure=$(grep -o "log: [^)]*" "$F/tasks/landed/$stale.md" | tail -1 | cut -c6-)
ok "the task file records a log path, not the failure output" \
  bash -c '! grep -q "error TS" "$0" && grep -q "error TS" "$1"' "$F/tasks/landed/$stale.md" "$failure"
ok "the task's record holds the verified facts" \
  bash -c 'grep -q "claimed by b1" "$0" && grep -q "proof passed" "$0" && grep -q "landed $1" "$0"' \
  "$F/tasks/landed/$stale.md" "$(meta "$stale" landed)"

idle=$(task 'do nothing' 'true')
waiter=$(task 'add VERSION2' 'echo "export const V2 = 2;" >src/v2.ts' --after "$idle")
for _ in 1 2 3 4; do dev build b1; done
ok "three bounces park a task in stuck" [ "$(state "$idle") $(meta "$idle" bounces)" = "stuck 3" ]
ok "a task waits while its dependency has not landed" [ "$(state "$waiter")" = ready ]
ok "status shows what a task waits on" bash -c "'$R/factory/dev' status 2>/dev/null | grep '$waiter' | grep -q 'waits on $idle'"

red=$(task 'shrink MAX_SLUG' 'sed -i "s/= 40/= 30/" src/limits.ts')
dev build b1
dev integrate
dev drain
fix=$(id_of "main red after $(meta "$red" landed | cut -c1-9)")
ok "red after the push filed a main-red task" [ -n "$fix" ]
ok "the main-red task names the landing as culprit" [ "$(meta "$fix" culprit)" = "$(meta "$red" landed)" ]
ok "the main-red task goes to the culprit's builder" [ "$(meta "$fix" owner)" = b1 ]
ok "main-green stayed on the last green commit" [ "$(green)" != "$(main)" ]
dev build b1
dev integrate
dev drain
ok "the fix landed through the fix lane" logged "$fix lane=fix"
ok "the fix turned main green" [ "$(state "$fix")" = landed ] && ok "main-green caught up" [ "$(green)" = "$(main)" ]

crash=$(task 'add VERSION' 'echo "export const VERSION = 1;" >src/version.ts' --after "$fix")
dev build b1
ok "a task whose dependency landed is built past a blocked one" [ "$(state "$crash")" = submitted ]
wt=$F/wt/_integrator
git -C "$wt" fetch -q origin
git -C "$wt" checkout -q --detach origin/main
git -C "$wt" merge -q --no-ff -m "merge task/$crash: add VERSION" "task/$crash"
git -C "$wt" push -q origin HEAD:main
pushed=$(git -C "$wt" rev-parse HEAD)
echo a >"$wt/src/z.ts" && git -C "$wt" add -A && git -C "$wt" commit -qm a
git -C "$wt" checkout -q --detach HEAD~1
echo b >"$wt/src/z.ts" && git -C "$wt" add -A && git -C "$wt" commit -qm b
! git -C "$wt" merge -q "HEAD@{2}" >/dev/null 2>&1 # killed with a conflicted merge open
dev integrate
dev drain
ok "an integrator that crashed after its push recovers the landing" [ "$(state "$crash") $(meta "$crash" landed)" = "landed $pushed" ]
ok "recovery did not land it twice" [ "$(main)" = "$pushed" ]

risky=$(task 'note in sources' 'echo "BUG" >>factory/sources.md')
dev build b1
dev integrate
dev drain
ok "a risky change was reviewed and its findings became a task" [ "$(meta "$(id_of "review findings for $risky")" owner)" = b1 ]

dev gate
ok "the scheduled gate passes a green main" logged "main green at $(main)"
git -C "$wt" checkout -q --detach origin/main
echo 'export const broken: number = "a";' >"$wt/src/broken.ts"
git -C "$wt" add -A
git -C "$wt" commit -qm "break main outside the factory"
git -C "$wt" push -q origin HEAD:main
dev gate
ok "the scheduled gate files a red main with its culprit" [ "$(meta "$(id_of "main red after $(main | cut -c1-9)")" culprit)" = "$(main)" ]

ok "every session the factory opened is listed for nesting" bash -c '
  for s in $(cut -d" " -f2 "$0" | sort -u); do grep -q "^$s " "$1" || exit 1; done
  grep -q " scout$" "$1" && grep -q " review " "$1"' "$tmp/sessions" "$F/sessions"

echo "ENGINE OK"
