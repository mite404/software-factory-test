import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const mergeQuery = `query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      headRefOid state mergeCommit { oid }
      commits(last:1) { nodes { commit {
        oid statusCheckRollup { contexts(first:100,after:$endCursor) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { id name status conclusion detailsUrl completedAt startedAt
              checkSuite { workflowRun { workflow { name } } } }
            ... on StatusContext { id context state targetUrl }
          }
        } }
      } } }
    }
  }
}`;

/** Resolve only the current branch's configured github.com remote. */
export function githubRepository(root: string): string | null {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const branch = git("branch", "--show-current");
    const remote = git("config", "--get", `branch.${branch}.remote`);
    const url = git("remote", "get-url", remote);
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
        url,
      );
    return match && ![".", ".."].includes(match[2]!)
      ? `${match[1]}/${match[2]}`
      : null;
  } catch {
    return null;
  }
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed GitHub pull request evidence");
  return { ...value };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validCheckFields(check: Record<string, unknown>) {
  if (check.__typename === "CheckRun")
    return (
      nonempty(check.name) &&
      nonempty(check.status) &&
      (check.conclusion === null || nonempty(check.conclusion))
    );
  return (
    check.__typename === "StatusContext" &&
    nonempty(check.context) &&
    nonempty(check.state)
  );
}

/** Recognize saved check fields, including older evidence recorded without an ID. */
export function validMergeCheck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check: Record<string, unknown> = { ...value };
  return (
    (check.id === undefined || nonempty(check.id)) && validCheckFields(check)
  );
}

/** Return whether a validated check is explicitly green. */
export function greenMergeCheck(check: Record<string, unknown>): boolean {
  return check.__typename === "CheckRun"
    ? check.status === "COMPLETED" && check.conclusion === "SUCCESS"
    : check.__typename === "StatusContext" && check.state === "SUCCESS";
}

function pullRow(page: unknown) {
  const envelope = row(page);
  if (envelope.errors !== undefined)
    throw new Error("GitHub reported pull request query errors");
  return row(row(row(envelope.data).repository).pullRequest);
}

function rollupCommit(pull: Record<string, unknown>) {
  const nodes = row(pull.commits).nodes;
  if (!Array.isArray(nodes) || nodes.length !== 1)
    throw new Error("Missing exact-head check attribution");
  return row(row(nodes[0]).commit);
}

function pullHead(page: unknown) {
  const pull = pullRow(page);
  const { headRefOid: head, state } = pull;
  const merge = pull.mergeCommit === null ? null : row(pull.mergeCommit).oid;
  const commit = rollupCommit(pull);
  if (
    typeof head !== "string" ||
    !/^[a-f0-9]{40}$/.test(head) ||
    head !== commit.oid
  )
    throw new Error("GitHub check attribution does not match the PR head");
  if (
    typeof state !== "string" ||
    (merge !== null && typeof merge !== "string")
  )
    throw new Error("Malformed GitHub pull request evidence");
  return { head, merge, state, rollup: commit.statusCheckRollup };
}

function checkPage(rollup: unknown, morePages: boolean) {
  const contexts =
    rollup === null
      ? {
          totalCount: 0,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        }
      : row(row(rollup).contexts);
  const { totalCount: total, nodes } = contexts;
  const { hasNextPage, endCursor } = row(contexts.pageInfo);
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Array.isArray(nodes) ||
    hasNextPage !== morePages
  )
    throw new Error("Incomplete GitHub check evidence");
  if (morePages && nodes.length === 0)
    throw new Error("Invalid GitHub check pagination cursor");
  return { total, checks: nodes.map(row), endCursor };
}

function validateCheckCursor(
  page: ReturnType<typeof checkPage>,
  cursors: Set<string>,
) {
  if (page.total === 0 && page.checks.length === 0 && page.endCursor === null)
    return;
  if (
    !page.checks.length ||
    !nonempty(page.endCursor) ||
    cursors.has(page.endCursor)
  )
    throw new Error("Invalid GitHub check pagination cursor");
  cursors.add(page.endCursor);
}

function collectCheckIDs(checks: Record<string, unknown>[], ids: Set<string>) {
  for (const check of checks) {
    if (!validMergeCheck(check))
      throw new Error(`Malformed GitHub check ${String(check.__typename)}`);
    if (!nonempty(check.id)) throw new Error("Missing GitHub check ID");
    if (ids.has(check.id)) throw new Error(`Duplicate check ID ${check.id}`);
    ids.add(check.id);
  }
}

/** Read and attribute every check to the observed PR head, without writing to GitHub.
 * @throws On unavailable, incomplete or unattributed evidence.
 */
export function readPullRequest(
  root: string,
  pr: number,
  query = (args: string[]) =>
    execFileSync("gh", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }),
) {
  const repository = githubRepository(root);
  if (!repository) throw new Error("No configured GitHub upstream repository");
  const [owner, repo] = repository.split("/");
  let pages: unknown;
  try {
    pages = JSON.parse(
      query([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `pr=${pr}`,
        "-f",
        `query=${mergeQuery}`,
      ]),
    );
  } catch {
    throw new Error(`Could not read GitHub pull request #${pr}`);
  }
  if (!Array.isArray(pages) || !pages.length)
    throw new Error("Incomplete GitHub check evidence");
  const { rollup, ...snapshot } = pullHead(pages[0]);
  const first = checkPage(rollup, pages.length > 1);
  const { total, checks } = first;
  const ids = new Set<string>();
  const cursors = new Set<string>();
  validateCheckCursor(first, cursors);
  collectCheckIDs(checks, ids);
  for (let index = 1; index < pages.length; index++) {
    const { rollup, ...pull } = pullHead(pages[index]);
    const page = checkPage(rollup, index < pages.length - 1);
    if (!isDeepStrictEqual(snapshot, pull) || total !== page.total)
      throw new Error("GitHub pull request evidence changed during pagination");
    validateCheckCursor(page, cursors);
    collectCheckIDs(page.checks, ids);
    checks.push(...page.checks);
  }
  if (checks.length !== total)
    throw new Error("Incomplete GitHub check evidence");
  return { ...snapshot, checks };
}
