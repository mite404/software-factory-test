import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, watchdogFixture } from "./bookkeeping.fixture";
import { digestConfigFiles, readConfigFiles } from "./config";
import {
  checkVerificationTools,
  configuration,
  createFactory,
  effectiveConfiguration,
  effectiveDefinition,
  migrateDefinition,
  type NativeHost,
} from "./native";
import { startDashboard } from "./dashboard";
import {
  evidenceContent,
  factoryDefinition,
  factoryEvents,
  factoryEvidence,
  factoryStatus,
} from "./persistence";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const instructions = "Fixture instructions\n";
const model = "anthropic/claude-opus-5-5";
const bookkeeping = "a".repeat(64);

// The dogfood definition's shape: two lanes, a named runner, review, setup and backup.
const flat = {
  version: 1,
  capacity: 2,
  mode: "bug-finding",
  workerModel: model,
  workerEffort: "medium",
  workerRunner: "factory-dogfood",
  review: true,
  orchestratorModel: "openai/gpt-6.2-sol",
  prd: "prd.md",
  tickets: "tickets.json",
  scope: ["factory/", "src/"],
  verify: "true",
  setup: "true",
  setupTimeoutMs: 5000,
  permissions: {
    execute: true,
    publish: false,
    externalTickets: false,
    backup: true,
  },
  bookkeepingSHA256: bookkeeping,
  backup: { repository: "owner/state", projectKey: "fixture-project" },
  lightWorker: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
  observer: { model: "anthropic/claude-haiku-5-5", effort: "low" },
};

// The same settings written by hand in the layout, not produced by the migration.
const layout: Record<string, string> = {
  "factory.yaml": `version: 1
capacity: 2
mode: bug-finding
prd: prd.md
tickets: tickets.json
scope:
  - factory/
  - src/
verify: "true"
permissions:
  execute: true
  publish: false
  externalTickets: false
  backup: true
backup:
  repository: owner/state
  projectKey: fixture-project
bookkeepingSHA256: ${bookkeeping}
`,
  "agents/foreman/agent.md":
    "---\nmodel: openai/gpt-6.2-sol\n---\n# Foreman\n\nOrchestrate.\n",
  "agents/implementer/agent.md": `---\nmodel: ${model}\neffort: medium\nrunner: factory-dogfood\n---\n`,
  "agents/light-implementer/agent.md":
    "---\nmodel: anthropic/claude-sonnet-5-5\neffort: high\n---\n",
  "agents/reviewer/agent.md": "---\n---\n",
  "agents/observer/agent.md":
    "---\nmodel: anthropic/claude-haiku-5-5\neffort: low\n---\n",
  "runners/factory-dogfood.yaml": 'setup: "true"\nsetupTimeoutMs: 5000\n',
};

// One lane, local executor, no review: what the engine tests run.
function lean(): Record<string, string> {
  const files = { ...layout };
  files["factory.yaml"] = files["factory.yaml"]!.replace(
    "capacity: 2",
    "capacity: 1",
  );
  files["agents/implementer/agent.md"] =
    `---\nmodel: ${model}\neffort: medium\n---\n`;
  for (const path of [
    "agents/light-implementer/agent.md",
    "agents/observer/agent.md",
    "agents/reviewer/agent.md",
    "runners/factory-dogfood.yaml",
  ])
    delete files[path];
  return files;
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "factory-config-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  // CI runners have no global Git identity.
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "prd.md"), instructions);
  await writeFile(
    join(root, "tickets.json"),
    JSON.stringify([{ id: "A", brief: "Work", after: [] }]),
  );
  return { root, git };
}

async function put(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, "factory/config", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

async function putFlat(root: string, path: string, raw: object = flat) {
  await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(
    join(root, path),
    path.endsWith(".yaml") ? Bun.YAML.stringify(raw) : JSON.stringify(raw),
  );
}

async function snapshot(root: string) {
  return Object.fromEntries(
    [...(await readConfigFiles(root))].map(([path, bytes]) => [
      path,
      bytes.toString(),
    ]),
  );
}

// The refusal's message; a promise that resolves fails the test.
async function refused(attempt: Promise<unknown>) {
  try {
    await attempt;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected a refusal");
}

const withoutDigest = <T extends object>(value: T) => ({
  ...value,
  digest: undefined,
});

test("the directory loads the same settings as the flat file", async () => {
  const f = await repository();
  await putFlat(f.root, ".factory.json");
  const fromFlat = await configuration(f.root);
  await rm(join(f.root, ".factory.json"));
  await put(f.root, layout);
  const fromDirectory = await configuration(f.root);
  expect(withoutDigest(fromDirectory)).toEqual(withoutDigest(fromFlat));
  expect(fromDirectory.digest).not.toBe(fromFlat.digest);
  expect(fromDirectory).toMatchObject({
    workerModel: model,
    workerEffort: "medium",
    workerRunner: "factory-dogfood",
    review: true,
    lightWorker: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
    observer: { model: "anthropic/claude-haiku-5-5", effort: "low" },
    setup: { command: "true", timeoutMs: 5000 },
    scope: ["factory/", "src/"],
    execute: true,
    backupAllowed: true,
    instructions,
  });
});

test("a repository with only .factory.json loads as before, beside only the bundled Foreman prompt too", async () => {
  const f = await repository();
  await putFlat(f.root, ".factory.json");
  const content = await readFile(join(f.root, ".factory.json"), "utf8");
  const digest = createHash("sha256")
    .update(content)
    .update("\0")
    .update(instructions)
    .digest("hex");
  expect((await configuration(f.root)).digest).toBe(digest);
  await put(f.root, { "agents/foreman/agent.md": "# Foreman\n" });
  expect((await configuration(f.root)).digest).toBe(digest);
});

test.each([
  ["an unknown file", { "unknown.yaml": "a: 1\n" }, "unknown.yaml"],
  [
    "an implementer file with an unknown key",
    { "agents/implementer/agent.md": `---\nmodel: ${model}\nbogus: 1\n---\n` },
    "agents/implementer/agent.md",
  ],
  [
    "a Foreman prompt with an unknown front matter key",
    { "agents/foreman/agent.md": "---\nbogus: true\n---\n# Foreman\n" },
    "agents/foreman/agent.md",
  ],
  [
    "a Foreman prompt with an unknown key after a trailing-space delimiter",
    { "agents/foreman/agent.md": "--- \nbogus: true\n---\t\n# Foreman\n" },
    "agents/foreman/agent.md",
  ],
  [
    "a Foreman prompt with CRLF front matter",
    { "agents/foreman/agent.md": "---\r\nbogus: true\r\n---\r\n# Foreman\r\n" },
    "agents/foreman/agent.md",
  ],
  [
    "a Foreman prompt with valid model front matter",
    {
      "agents/foreman/agent.md":
        "---\nmodel: openai/gpt-6.2-sol\n---\n# Foreman\n",
    },
    "agents/foreman/agent.md",
  ],
  [
    "a valid agent file",
    { "agents/implementer/agent.md": layout["agents/implementer/agent.md"]! },
    "agents/implementer/agent.md",
  ],
])(
  "refuses %s beside a flat definition when the directory has no factory.yaml",
  async (_name, files, path) => {
    const f = await repository();
    await putFlat(f.root, ".factory.json");
    await put(f.root, { "agents/foreman/agent.md": "# Foreman\n", ...files });
    expect(await refused(configuration(f.root))).toMatch(
      new RegExp(
        `factory/config/${path}: is not allowed beside a flat definition`,
      ),
    );
  },
);

test.each([
  ["never closes", "---\nbogus: true\n# Foreman\n"],
  ["starts after a blank line", "\n---\nbogus: true\n---\n# Foreman\n"],
  ["opens with ----", "----\nbogus: true\n---\n# Foreman\n"],
])(
  "refuses a Foreman prompt whose front matter %s beside a flat definition",
  async (_name, text) => {
    const f = await repository();
    await putFlat(f.root, ".factory.json");
    await put(f.root, { "agents/foreman/agent.md": text });
    expect(await refused(configuration(f.root))).toMatch(
      /factory\/config\/agents\/foreman\/agent\.md: has malformed front matter/,
    );
  },
);

const refusals: [string, (files: Record<string, string>) => void, RegExp][] = [
  [
    "an unknown setting in factory.yaml",
    (files) => (files["factory.yaml"] += "bogus: 1\n"),
    /factory\/config\/factory\.yaml: unsupported setting bogus/,
  ],
  [
    "a flat setting that belongs to an agent file",
    (files) => (files["factory.yaml"] += `workerModel: ${model}\n`),
    /factory\/config\/factory\.yaml: unsupported setting workerModel/,
  ],
  [
    "an unknown setting in an agent file",
    (files) =>
      (files["agents/implementer/agent.md"] =
        `---\nmodel: ${model}\nbogus: 1\n---\n`),
    /agents\/implementer\/agent\.md: unsupported setting bogus/,
  ],
  [
    "an unknown setting in a runner file",
    (files) => (files["runners/factory-dogfood.yaml"] += "bogus: 1\n"),
    /runners\/factory-dogfood\.yaml: unsupported setting bogus/,
  ],
  [
    "an unknown file",
    (files) => (files["notes.md"] = "hello\n"),
    /factory\/config\/notes\.md: is not part of the config layout/,
  ],
  [
    "an unknown agent",
    (files) => (files["agents/spare/agent.md"] = "---\n---\n"),
    /factory\/config\/agents\/spare: is not part of the config layout/,
  ],
  [
    "a missing factory.yaml",
    (files) => delete files["factory.yaml"],
    /factory\/config\/factory\.yaml: is required/,
  ],
  [
    "a missing implementer",
    (files) => delete files["agents/implementer/agent.md"],
    /agents\/implementer\/agent\.md: is required/,
  ],
  [
    "a required setting left out",
    (files) =>
      (files["factory.yaml"] = files["factory.yaml"]!.replace(
        "prd: prd.md\n",
        "",
      )),
    /factory\.yaml: prd is required/,
  ],
  [
    "an agent file without front matter",
    (files) => (files["agents/implementer/agent.md"] = "no front matter\n"),
    /agents\/implementer\/agent\.md: model is required/,
  ],
  [
    "an agent file with CRLF front matter and an unknown key",
    (files) =>
      (files["agents/implementer/agent.md"] =
        `---\r\nmodel: ${model}\r\nbogus: 1\r\n---\r\n`),
    /agents\/implementer\/agent\.md: unsupported setting bogus/,
  ],
  [
    "an agent file whose front matter never closes",
    (files) =>
      (files["agents/implementer/agent.md"] = `---\nmodel: ${model}\n`),
    /agents\/implementer\/agent\.md: has malformed front matter/,
  ],
  [
    "an agent naming a runner with no file",
    (files) => delete files["runners/factory-dogfood.yaml"],
    /agents\/implementer\/agent\.md: names runner factory-dogfood but runners\/factory-dogfood\.yaml is missing/,
  ],
  [
    "a runner file no agent names",
    (files) => (files["runners/spare.yaml"] = 'setup: "true"\n'),
    /runners\/spare\.yaml: no agent names this runner/,
  ],
  [
    "a runner name that escapes the directory",
    (files) =>
      (files["agents/implementer/agent.md"] =
        `---\nmodel: ${model}\nrunner: ../escape\n---\n`),
    /agents\/implementer\/agent\.md: runner must be a runner ID/,
  ],
  [
    "a non-empty implementer body",
    (files) => (files["agents/implementer/agent.md"] += "Do the work.\n"),
    /agents\/implementer\/agent\.md: instructions are not read yet/,
  ],
  [
    "an observer without an effort",
    (files) =>
      (files["agents/observer/agent.md"] =
        "---\nmodel: anthropic/claude-haiku-5-5\n---\n"),
    /agents\/observer\/agent\.md: effort is required/,
  ],
  [
    "an observer on an unknown model",
    (files) =>
      (files["agents/observer/agent.md"] =
        "---\nmodel: acme/unknown\neffort: low\n---\n"),
    /^factory\/config: Invalid observer/,
  ],
  [
    "a non-empty observer body",
    (files) => (files["agents/observer/agent.md"] += "Watch.\n"),
    /agents\/observer\/agent\.md: instructions are not read yet/,
  ],
  [
    "a non-empty reviewer body",
    (files) => (files["agents/reviewer/agent.md"] += "Be strict.\n"),
    /agents\/reviewer\/agent\.md: instructions are not read yet/,
  ],
  [
    "publish: true",
    (files) =>
      (files["factory.yaml"] = files["factory.yaml"]!.replace(
        "publish: false",
        "publish: true",
      )),
    /^factory\/config: Only local execution is supported/,
  ],
];

test.each(refusals)("refuses %s", async (_name, break_, message) => {
  const f = await repository();
  const files = { ...layout };
  break_(files);
  await put(f.root, files);
  expect(await refused(configuration(f.root))).toMatch(message);
});

test.each([".factory.json", "factory/definition.yaml"])(
  "refuses the directory beside %s",
  async (path) => {
    const f = await repository();
    await putFlat(f.root, path);
    await put(f.root, layout);
    expect(await refused(configuration(f.root))).toMatch(
      `Conflicting definitions: factory/config/factory.yaml and ${path}`,
    );
  },
);

test("every config file changes the digest, and the digest hashes paths in sorted order", async () => {
  const f = await repository();
  await put(f.root, layout);
  const base = (await configuration(f.root)).digest;
  const seen = new Set([base]);
  for (const [path, text] of Object.entries(layout)) {
    // One more newline is valid in every file and changes one byte.
    await put(f.root, { [path]: `${text}\n` });
    seen.add((await configuration(f.root)).digest);
    await put(f.root, { [path]: text });
  }
  expect(seen.size).toBe(Object.keys(layout).length + 1);
  expect((await configuration(f.root)).digest).toBe(base);

  const a = Buffer.from("same");
  const forward = new Map([
    ["agents/a.md", a],
    ["runners/b.yaml", Buffer.from("b")],
  ]);
  const reversed = new Map([...forward].reverse());
  expect(digestConfigFiles(reversed, "x")).toBe(
    digestConfigFiles(forward, "x"),
  );
  // The same bytes under another path are a different configuration.
  expect(digestConfigFiles(new Map([["agents/a.md", a]]), "x")).not.toBe(
    digestConfigFiles(new Map([["agents/b.md", a]]), "x"),
  );
});

async function engine(extra: Record<string, string> = {}) {
  const f = await repository();
  await put(f.root, { ...lean(), ...extra });
  await mkdir(join(f.root, "src"));
  await writeFile(join(f.root, "src/keep.ts"), "export {};\n");
  f.git("add", ".");
  f.git("commit", "-qm", "fixture");
  const host: NativeHost = {
    async create() {
      return "T-worker";
    },
    async send() {},
    async state() {
      return "running";
    },
    watch() {},
  };
  const factory = createFactory(f.root, host, openStore);
  const { tools } = watchdogFixture();
  const tick = (action: "start" | "reconcile" | "reload") =>
    factory.tick(action, "T-owner", host.state, undefined, tools);
  return { ...f, host, factory, tick, tools };
}

test("an edit to a config file changes nothing for the active run until reload", async () => {
  const f = await engine();
  const started = await f.tick("start");
  const run = started.runs.A;
  if (run?.kind !== "running") throw new Error("Expected a running worker");
  const accepted = await effectiveConfiguration(f.root);
  expect(accepted.workerEffort).toBe("medium");

  const path = join(f.root, "factory/config/agents/implementer/agent.md");
  await writeFile(path, `---\nmodel: ${model}\neffort: low\n---\n`);
  f.git("commit", "-qam", "edit effort");
  const edited = await configuration(f.root);
  expect(edited.workerEffort).toBe("low");
  const unreloaded = await effectiveConfiguration(f.root);
  expect(unreloaded.workerEffort).toBe("medium");
  expect(unreloaded.digest).toBe(accepted.digest);

  await f.tick("reload");
  const reloaded = await effectiveConfiguration(f.root);
  expect(reloaded.workerEffort).toBe("low");
  expect(reloaded.digest).toBe(edited.digest);
  expect(
    factoryDefinition(f.factory.directory, run.definition)?.workerEffort,
  ).toBe("medium");
});

// A worker commit that adds `text` to `path`, then reports it as the first candidate.
async function submit(f: Awaited<ReturnType<typeof engine>>, path: string) {
  await f.tick("start");
  const worktree = join(f.root, ".git/factory/worktrees/A");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
  await mkdir(dirname(join(worktree, path)), { recursive: true });
  const file = join(worktree, path);
  const old = existsSync(file) ? await readFile(file, "utf8") : "";
  await writeFile(file, `${old}\n`);
  git("add", "-A");
  git("commit", "-qm", "edit");
  await writeFile(
    join(f.factory.directory, "A.report.json"),
    JSON.stringify({
      attempt: 1,
      kind: "candidate",
      revision: git("rev-parse", "HEAD"),
      insight: "Verified candidate",
    }),
  );
  f.host.state = async () => "idle";
  return f.tick("reconcile");
}

test.each([
  "factory/config/agents/implementer/agent.md",
  "factory/config/runners/x.yaml",
])(
  "rejects a candidate that edits %s although factory/ is in scope",
  async (path) => {
    const result = await submit(await engine(), path);
    expect(result.runs.A).toMatchObject({ kind: "running", attempt: 2 });
  },
);

test("accepts the same candidate when it edits only files in scope outside the directory", async () => {
  const result = await submit(await engine(), "factory/notes.txt");
  expect(result.runs.A?.kind).toBe("done");
});

async function migrationRepository(path = ".factory.json") {
  const f = await repository();
  await putFlat(f.root, path);
  return f;
}

test.each([".factory.json", "factory/definition.yaml"])(
  "migrates %s into the directory, repeatably, with the same effective view",
  async (path) => {
    const f = await migrationRepository(path);
    const before = await configuration(f.root);
    const effective = await effectiveDefinition(f.root);
    await migrateDefinition(f.root);
    expect(existsSync(join(f.root, path))).toBe(false);
    const files = await snapshot(f.root);
    expect(Object.keys(files).sort()).toEqual(Object.keys(layout).sort());
    const after = await configuration(f.root);
    expect(withoutDigest(after)).toEqual(withoutDigest(before));
    expect(after.digest).not.toBe(before.digest);
    expect(await effectiveDefinition(f.root)).toEqual({
      ...effective,
      digest: after.digest,
    });
    await migrateDefinition(f.root);
    expect(await snapshot(f.root)).toEqual(files);
    expect((await configuration(f.root)).digest).toBe(after.digest);
  },
);

test("migration keeps an existing Foreman prompt body and adds its model", async () => {
  const f = await migrationRepository();
  const body = "# Foreman\n\nBody stays.\n";
  await put(f.root, { "agents/foreman/agent.md": body });
  await migrateDefinition(f.root);
  const migrated = (await snapshot(f.root))["agents/foreman/agent.md"]!;
  expect(migrated.startsWith("---\nmodel: openai/gpt-6.2-sol\n---\n")).toBe(
    true,
  );
  expect(migrated.endsWith(`---\n${body}`)).toBe(true);
});

test.each([
  [
    "a differing existing file",
    { "agents/implementer/agent.md": `---\nmodel: ${model}\n---\n` },
    flat,
    /agents\/implementer\/agent\.md: exists and differs/,
  ],
  [
    "an unplanned file",
    { "notes.md": "mine\n" },
    flat,
    /notes\.md: is not part of this definition/,
  ],
  [
    "an invalid flat definition",
    {},
    { ...flat, permissions: { ...flat.permissions, publish: true } },
    /Only local execution is supported/,
  ],
])(
  "migration refuses %s and writes nothing",
  async (_name, existing, raw, message) => {
    const f = await repository();
    await putFlat(f.root, ".factory.json", raw);
    await put(f.root, existing);
    const before = existsSync(join(f.root, "factory/config"))
      ? await snapshot(f.root)
      : undefined;
    expect(await refused(migrateDefinition(f.root))).toMatch(message);
    expect(existsSync(join(f.root, ".factory.json"))).toBe(true);
    expect(
      existsSync(join(f.root, "factory/config"))
        ? await snapshot(f.root)
        : undefined,
    ).toEqual(before);
  },
);

test("an interrupted migration is never loaded half-written and completes on repeat", async () => {
  const done = await migrationRepository();
  await migrateDefinition(done.root);
  const files = await snapshot(done.root);
  const expected = (await configuration(done.root)).digest;

  // Interrupted before factory.yaml: neither source loads until the repeat completes it.
  const early = await migrationRepository();
  const { "factory.yaml": settings, ...rest } = files;
  await put(early.root, rest);
  expect(await refused(configuration(early.root))).toMatch(
    /is not allowed beside a flat definition/,
  );
  await migrateDefinition(early.root);
  expect(await snapshot(early.root)).toEqual(files);
  expect((await configuration(early.root)).digest).toBe(expected);

  // Interrupted before the flat file was removed: a conflict until the repeat finishes it.
  const late = await migrationRepository();
  await put(late.root, files);
  expect(await refused(configuration(late.root))).toMatch(
    /Conflicting definitions/,
  );
  await migrateDefinition(late.root);
  expect(existsSync(join(late.root, ".factory.json"))).toBe(false);
  expect((await configuration(late.root)).digest).toBe(expected);

  // A truncated factory.yaml is refused, never read as a definition or overwritten.
  const torn = await migrationRepository();
  await put(torn.root, { ...rest, "factory.yaml": "version: 1\n" });
  expect(await refused(configuration(torn.root))).toMatch(
    /Conflicting definitions/,
  );
  expect(await refused(migrateDefinition(torn.root))).toMatch(
    /factory\.yaml: exists and differs/,
  );
  expect(existsSync(join(torn.root, ".factory.json"))).toBe(true);
  expect(settings).toContain("version: 1");
});

test("an interruption between linking a file and removing its scratch never corrupts it on retry", async () => {
  const done = await migrationRepository();
  await migrateDefinition(done.root);
  const files = await snapshot(done.root);

  // The first file is installed, but its scratch name still shares the inode.
  const f = await migrationRepository();
  const before = await configuration(f.root);
  const installed = "agents/implementer/agent.md";
  await put(f.root, { [installed]: files[installed]! });
  const installedPath = join(f.root, "factory/config", installed);
  // The fixed name a retry would reopen for writing, and a numbered scratch directory.
  const fixed = join(f.root, "factory/.config-migrating");
  const scratch = `${fixed}1`;
  await link(installedPath, fixed);
  await mkdir(scratch);
  await link(installedPath, join(scratch, "0"));

  await migrateDefinition(f.root);
  expect(await snapshot(f.root)).toEqual(files);
  const after = await configuration(f.root);
  expect(withoutDigest(after)).toEqual(withoutDigest(before));
  expect(existsSync(scratch)).toBe(false);
  expect(existsSync(fixed)).toBe(false);
  expect(existsSync(join(f.root, ".factory.json"))).toBe(false);
});

// A config root that is a link, inside or outside the repository, in each place the loader looks.
test.each(["inside", "outside"])(
  "refuses a config root linked %s the repository and migration writes through nothing",
  async (where) => {
    const f = await repository();
    const outside = await mkdtemp(join(tmpdir(), "factory-config-outside-"));
    roots.push(outside);
    const target = where === "inside" ? join(f.root, "src/settings") : outside;
    await mkdir(target, { recursive: true });
    await mkdir(join(f.root, "factory"));
    await symlink(target, join(f.root, "factory/config"));
    const refusal = /factory\/config must be a real directory/;

    // Nothing else defines the project: the linked directory is not a definition.
    expect(await refused(configuration(f.root))).toMatch(refusal);
    // With a populated target the files load nowhere, including beside a flat file.
    await put(f.root, layout);
    expect(await refused(configuration(f.root))).toMatch(refusal);
    await putFlat(f.root, ".factory.json");
    expect(await refused(configuration(f.root))).toMatch(refusal);
    expect(await refused(migrateDefinition(f.root))).toMatch(refusal);
    expect(existsSync(join(f.root, ".factory.json"))).toBe(true);
  },
);

test("refuses a linked factory directory that holds a config directory", async () => {
  const f = await repository();
  await mkdir(join(f.root, "src/real/config"), { recursive: true });
  await writeFile(join(f.root, "src/real/config/factory.yaml"), "");
  await symlink(join(f.root, "src/real"), join(f.root, "factory"));
  expect(await refused(configuration(f.root))).toMatch(
    /must be a real directory/,
  );
});

test.each(["unsupported", "agents/spare", "runners/nested"])(
  "refuses an empty unknown directory %s",
  async (path) => {
    const f = await repository();
    await put(f.root, layout);
    await mkdir(join(f.root, "factory/config", path), { recursive: true });
    expect(await refused(configuration(f.root))).toMatch(
      new RegExp(`factory/config/${path}: is not part of the config layout`),
    );
  },
);

test("the observer registers with the authored model and effort, and keeps the default without one", async () => {
  for (const [files, expected] of [
    [
      {
        "agents/observer/agent.md":
          "---\nmodel: anthropic/claude-sonnet-5-5\neffort: low\n---\n",
      },
      ["T-owner", "anthropic/claude-sonnet-5-5", "low", "observer"],
    ],
    [{}, ["T-owner", "anthropic/claude-haiku-5-5", "high", "observer"]],
  ] as const) {
    const f = await engine(files);
    await f.tick("start");
    const created: unknown[] = [];
    f.host.create = async (...args) => {
      created.push(args);
      return "T-observer";
    };
    await f.factory.observer("register-observer", "T-owner", f.tools);
    expect(created).toEqual([expected]);
    expect((await f.factory.tick("status")).foreman?.observer).toMatchObject({
      thread: "T-observer",
      model: expected[1],
      effort: expected[2],
    });
  }
});

test("refuses migration through a linked factory directory with no config child, writing nothing", async () => {
  const f = await repository();
  await putFlat(f.root, ".factory.json");
  await mkdir(join(f.root, "src/shared"), { recursive: true });
  await writeFile(join(f.root, "src/shared/keep.ts"), "export {};\n");
  await symlink(join(f.root, "src/shared"), join(f.root, "factory"));
  const listing = () =>
    readdir(join(f.root, "src/shared"), { recursive: true });
  const before = await listing();

  expect(await refused(migrateDefinition(f.root))).toMatch(
    /factory must be a real directory/,
  );
  expect(await listing()).toEqual(before);
  expect(existsSync(join(f.root, ".factory.json"))).toBe(true);
  // Reads of a flat-only project are unaffected by the link.
  expect((await configuration(f.root)).workerModel).toBe(model);
});

const observerFile = (model: string, effort: string) => ({
  "agents/observer/agent.md": `---\nmodel: ${model}\neffort: ${effort}\n---\n`,
});

test("an unreloaded observer edit stays inactive, also after reopening, until reload", async () => {
  const a = ["anthropic/claude-haiku-5-5", "low"] as const;
  const b = ["anthropic/claude-sonnet-5-5", "medium"] as const;
  const f = await engine(observerFile(...a));
  await f.tick("start");
  await put(f.root, observerFile(...b));
  const accepted = await effectiveConfiguration(f.root);
  expect(accepted.observer).toEqual({ model: a[0], effort: a[1] });
  expect(accepted.digest).not.toBe((await configuration(f.root)).digest);

  const created: unknown[] = [];
  const register = async (factory: typeof f.factory) => {
    f.host.create = async (...args) => {
      created.push(args.slice(1));
      return "T-observer";
    };
    await factory.observer("register-observer", "T-owner", f.tools);
  };
  const remove = (factory: typeof f.factory) =>
    factory.observer("remove-observer", "T-owner", f.tools);
  await register(f.factory);
  await remove(f.factory);
  const reopened = createFactory(f.root, f.host, openStore);
  await register(reopened);
  await remove(reopened);
  expect(created).toEqual([
    [...a, "observer"],
    [...a, "observer"],
  ]);

  await f.tick("reload");
  await register(f.factory);
  expect(created.at(-1)).toEqual([...b, "observer"]);
});

test("an observer first authored after the accepted definition stays inactive until reload", async () => {
  const f = await engine();
  await f.tick("start");
  await put(f.root, observerFile("anthropic/claude-sonnet-5-5", "low"));
  expect((await effectiveConfiguration(f.root)).observer).toBeUndefined();
  const created: unknown[] = [];
  f.host.create = async (...args) => {
    created.push(args.slice(1));
    return "T-observer";
  };
  await f.factory.observer("register-observer", "T-owner", f.tools);
  expect(created).toEqual([["anthropic/claude-haiku-5-5", "high", "observer"]]);
});

// The lean layout gated by check files instead of a flat verify.
function checked(checks: Record<string, string>): Record<string, string> {
  const files = lean();
  files["factory.yaml"] = files["factory.yaml"]!.replace(
    'verify: "true"\n',
    "",
  );
  for (const [name, text] of Object.entries(checks))
    files[`checks/${name}.yaml`] = text;
  return files;
}

const passing = { test: "command: echo ok\norder: 1\n" };

const checkRefusals: [
  string,
  Record<string, string>,
  ((root: string) => Promise<unknown>) | null,
  RegExp,
][] = [
  [
    "a linked checks/ directory",
    {},
    async (root) => {
      await mkdir(join(root, "elsewhere"));
      await writeFile(join(root, "elsewhere/test.yaml"), passing.test);
      await symlink(
        join(root, "elsewhere"),
        join(root, "factory/config/checks"),
      );
    },
    /factory\/config\/checks: must be a regular file/,
  ],
  [
    "a linked check file",
    passing,
    (root) =>
      symlink(
        join(root, "factory/config/checks/test.yaml"),
        join(root, "factory/config/checks/alias.yaml"),
      ),
    /factory\/config\/checks\/alias\.yaml: must be a regular file/,
  ],
  [
    "a check that is a FIFO",
    passing,
    async (root) =>
      execFileSync("mkfifo", [join(root, "factory/config/checks/pipe.yaml")]),
    /factory\/config\/checks\/pipe\.yaml: must be a regular file/,
  ],
  [
    "a subdirectory inside checks/",
    { ...passing, "nested/test": passing.test },
    null,
    /factory\/config\/checks\/nested: is not part of the config layout/,
  ],
  [
    "a non-.yaml file inside checks/",
    passing,
    (root) => writeFile(join(root, "factory/config/checks/notes.txt"), "x\n"),
    /factory\/config\/checks\/notes\.txt: is not part of the config layout/,
  ],
  [
    "an empty checks/ directory",
    {},
    (root) => mkdir(join(root, "factory/config/checks"), { recursive: true }),
    /factory\/config\/checks: is empty/,
  ],
  [
    "checks/ with no required check",
    { lint: "command: echo ok\norder: 1\nrequired: false\n" },
    null,
    /factory\/config\/checks: has no required check/,
  ],
  [
    "an unknown key in a check",
    { test: "command: echo ok\norder: 1\nretries: 2\n" },
    null,
    /factory\/config\/checks\/test\.yaml: unsupported setting retries/,
  ],
  [
    "a check without a command",
    { test: "order: 1\n" },
    null,
    /factory\/config\/checks\/test\.yaml: command is required/,
  ],
  [
    "a check with an empty command",
    { test: 'command: "  "\norder: 1\n' },
    null,
    /factory\/config\/checks\/test\.yaml: command must be a non-empty string/,
  ],
  [
    "a check without an order",
    { test: "command: echo ok\n" },
    null,
    /factory\/config\/checks\/test\.yaml: order is required/,
  ],
  [
    "a fractional timeoutMs",
    { test: "command: echo ok\norder: 1\ntimeoutMs: 1.5\n" },
    null,
    /factory\/config\/checks\/test\.yaml: timeoutMs must be a positive integer/,
  ],
  [
    "a zero timeoutMs",
    { test: "command: echo ok\norder: 1\ntimeoutMs: 0\n" },
    null,
    /factory\/config\/checks\/test\.yaml: timeoutMs must be a positive integer/,
  ],
  [
    "a negative order",
    { test: "command: echo ok\norder: -1\n" },
    null,
    /factory\/config\/checks\/test\.yaml: order must be a positive integer/,
  ],
  [
    "a string order",
    { test: 'command: echo ok\norder: "1"\n' },
    null,
    /factory\/config\/checks\/test\.yaml: order must be a positive integer/,
  ],
  [
    "a non-boolean required",
    { test: "command: echo ok\norder: 1\nrequired: yes please\n" },
    null,
    /factory\/config\/checks\/test\.yaml: required must be true or false/,
  ],
  [
    "invalid YAML in a check",
    { test: "command: [unclosed\n" },
    null,
    /factory\/config\/checks\/test\.yaml: is not valid YAML/,
  ],
];

test.each(checkRefusals)(
  "refuses %s",
  async (_name, checks, arrange, message) => {
    const f = await repository();
    await put(f.root, checked(checks));
    await arrange?.(f.root);
    expect(await refused(configuration(f.root))).toMatch(message);
  },
);

test("refuses checks/ beside a verify in factory.yaml, and a directory with neither", async () => {
  const f = await repository();
  await put(f.root, { ...lean(), "checks/test.yaml": passing.test });
  expect(await refused(configuration(f.root))).toMatch(
    /factory\/config\/factory\.yaml: verify is not allowed beside checks\//,
  );
  const g = await repository();
  await put(g.root, checked({}));
  expect(await refused(configuration(g.root))).toMatch(
    /factory\/config\/factory\.yaml: verify is required unless checks\/ holds checks/,
  );
});

test("refuses checks/ in a project that still uses a flat definition", async () => {
  const f = await repository();
  await putFlat(f.root, ".factory.json");
  await put(f.root, { "checks/test.yaml": passing.test });
  expect(await refused(configuration(f.root))).toMatch(
    /factory\/config\/checks\/test\.yaml: is not allowed beside a flat definition/,
  );
});

test("checks run by order, ties by name, with defaults for required and timeoutMs", async () => {
  const f = await repository();
  await put(
    f.root,
    checked({
      zeta: "command: echo z\norder: 1\n",
      beta: "command: echo b\norder: 2\nrequired: false\ntimeoutMs: 5000\n",
      alpha: "command: echo a\norder: 2\n",
    }),
  );
  expect((await configuration(f.root)).checks).toEqual([
    { name: "zeta", command: "echo z", required: true, timeoutMs: 600_000 },
    { name: "alpha", command: "echo a", required: true, timeoutMs: 600_000 },
    { name: "beta", command: "echo b", required: false, timeoutMs: 5000 },
  ]);
});

async function checkedEngine(checks: Record<string, string>) {
  const f = await engine();
  const config = join(f.root, "factory/config");
  await writeFile(join(config, "factory.yaml"), checked({})["factory.yaml"]!);
  await put(f.root, checked(checks));
  f.git("add", "-A");
  f.git("commit", "-qm", "checks");
  const sent: string[] = [];
  f.host.send = async (_thread, message) => {
    sent.push(message);
  };
  return { ...f, sent };
}

async function installedTool(name: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-tool-"));
  roots.push(root);
  const tool = join(root, name);
  const count = join(root, "invocations");
  await writeFile(count, "");
  await writeFile(
    tool,
    `#!/bin/sh
case "$1" in
  --version) echo version >> '${count}'; echo '${name} 1.7' ;;
  run) echo check >> '${count}'; echo 'verified ${name}' ;;
  *) exit 9 ;;
esac
`,
  );
  await chmod(tool, 0o755);
  const command = `'${tool}' run`;
  const capability = {
    tool,
    versionArgs: ["--version"],
    coverage: [`${name} contracts`],
  };
  return {
    tool,
    count,
    command,
    capability,
    check: Bun.YAML.stringify({ command, order: 1, capability }),
  };
}

test("declared capabilities reuse two installed tools and bind private results without observation reruns", async () => {
  for (const name of ["action-checks", "verification-cli"]) {
    const tool = await installedTool(name);
    const f = await checkedEngine({ local: tool.check });
    const result = await submit(f, "src/keep.ts");
    const done = result.runs.A;
    if (done?.kind !== "done") throw new Error("Expected accepted candidate");
    const gate = factoryEvidence(f.factory.directory, "A")!.find(
      (row) => row.kind === "gate",
    )!;
    expect(gate).toMatchObject({
      revision: done.revision,
      outcome: "gate-passed",
    });
    expect(
      JSON.parse(evidenceContent(f.factory.directory, "A", gate.sha256)).checks,
    ).toMatchObject([
      {
        name: "local",
        command: tool.command,
        required: true,
        status: "pass",
        revision: done.revision,
        capability: {
          ...tool.capability,
          executable: tool.tool,
          version: `${name} 1.7`,
        },
      },
    ]);
    expect(
      factoryDefinition(f.factory.directory, done.definition)?.checks?.[0]
        ?.capability,
    ).toEqual(tool.capability);
    const reopened = createFactory(f.root, f.host, openStore);
    await reopened.tick("status");
    await reopened.tick(
      "reconcile",
      "T-owner",
      f.host.state,
      undefined,
      f.tools,
    );
    await effectiveDefinition(f.root);
    const server = startDashboard({ root: f.root, port: 0 });
    try {
      for (const path of [
        "/api/status",
        "/api/events",
        "/api/evidence?ticket=A",
        "/api/definition",
      ]) {
        const response = await fetch(`http://localhost:${server.port}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain(tool.tool);
      }
    } finally {
      await server.stop(true);
    }
    expect(await readFile(tool.count, "utf8")).toBe("version\ncheck\n");
  }
});

test("an executable with an empty, failing or timed-out version probe never runs its check", async () => {
  for (const probe of ["exit 0", "echo unconfirmed; exit 3", "sleep 5"]) {
    const tool = await installedTool("unconfirmed");
    await writeFile(
      tool.tool,
      `#!/bin/sh
if [ "$1" = --version ]; then ${probe}; fi
echo check >> '${tool.count}'
`,
    );
    const f = await checkedEngine({
      local: Bun.YAML.stringify({
        command: tool.command,
        order: 1,
        timeoutMs: 1000,
        capability: tool.capability,
      }),
    });
    expect((await submit(f, "src/keep.ts")).runs.A).toMatchObject({
      kind: "running",
      attempt: 2,
    });
    expect(await readFile(tool.count, "utf8")).toBe("");
    const gate = factoryEvidence(f.factory.directory, "A")!.find(
      (row) => row.kind === "gate",
    )!;
    expect(gate.outcome).toBe("gate-failed");
    expect(
      JSON.parse(evidenceContent(f.factory.directory, "A", gate.sha256))
        .checks[0],
    ).toMatchObject({ capability: { executable: tool.tool, version: null } });
  }
});

test("a missing required capability rejects despite a green advisory, without running the missing check", async () => {
  const required = await installedTool("formal-check");
  const advisory = await installedTool("ci-watch");
  const f = await checkedEngine({
    required: required.check,
    advisory: Bun.YAML.stringify({
      command: advisory.command,
      order: 2,
      required: false,
      capability: advisory.capability,
    }),
  });
  await rm(required.tool);
  const config = await configuration(f.root);
  expect(
    await refused(checkVerificationTools(f.root, config.checks)),
  ).toContain("Verification capability required");
  const run = (await submit(f, "src/keep.ts")).runs.A;
  expect(run).toMatchObject({
    kind: "running",
    attempt: 2,
    checks: {
      results: [
        { name: "required", required: true, status: "fail" },
        { name: "advisory", required: false, status: "pass" },
      ],
    },
  });
  expect(f.sent.at(-1)).toContain(
    "Capability unavailable or version unconfirmed",
  );
  expect(f.sent.at(-1)).not.toContain("Gate failed twice");
  expect(await readFile(required.count, "utf8")).toBe("");
  expect(await readFile(advisory.count, "utf8")).toBe("version\ncheck\n");
  const gate = factoryEvidence(f.factory.directory, "A")!.find(
    (row) => row.kind === "gate",
  )!;
  expect(gate.outcome).toBe("gate-failed");
  expect(
    JSON.parse(evidenceContent(f.factory.directory, "A", gate.sha256))
      .checks[0],
  ).toMatchObject({
    command: required.command,
    revision: gate.revision,
    capability: {
      tool: required.tool,
      executable: null,
      version: null,
      coverage: ["formal-check contracts"],
    },
  });
});

test("an unavailable advisory capability cannot reject a passing mandatory tool", async () => {
  const required = await installedTool("local-check");
  const advisory = await installedTool("optional-check");
  const f = await checkedEngine({
    required: required.check,
    advisory: Bun.YAML.stringify({
      command: advisory.command,
      order: 2,
      required: false,
      capability: advisory.capability,
    }),
  });
  await rm(advisory.tool);
  await checkVerificationTools(f.root, (await configuration(f.root)).checks);
  expect((await submit(f, "src/keep.ts")).runs.A).toMatchObject({
    kind: "done",
    checks: {
      results: [
        { name: "required", status: "pass" },
        { name: "advisory", status: "fail" },
      ],
    },
  });
  expect(await readFile(required.count, "utf8")).toBe(
    "version\nversion\ncheck\n",
  );
  expect(await readFile(advisory.count, "utf8")).toBe("");
});

test("capability keys and incomplete contracts are refused at definition load", async () => {
  const f = await repository();
  const valid = {
    tool: "some-tool",
    versionArgs: ["--version"],
    coverage: ["contracts"],
  };
  for (const capability of [
    { ...valid, unknownCapability: true },
    { ...valid, tool: " " },
    { ...valid, coverage: [] },
    { ...valid, versionArgs: [] },
    { tool: "some-tool", coverage: ["contracts"] },
  ]) {
    await put(
      f.root,
      checked({
        test: Bun.YAML.stringify({ command: "true", order: 1, capability }),
      }),
    );
    expect(await refused(configuration(f.root))).toContain(
      "checks/test.yaml: invalid capability",
    );
  }
});

test("a stale passing capability gate cannot accept a rebased candidate after its required tool disappears", async () => {
  const tool = await installedTool("revision-check");
  const f = await checkedEngine({ local: tool.check });
  await put(f.root, { "agents/reviewer/agent.md": "---\n---\n" });
  f.git("add", "-A");
  f.git("commit", "-qm", "review on");
  await submit(f, "src/keep.ts");
  await f.tick("reconcile");
  const run = (await f.tick("reconcile")).runs.A;
  if (run?.kind !== "running" || !run.review)
    throw new Error("Expected a sent review");
  const review = run.review;
  await writeFile(join(f.root, "src/independent.ts"), "export {};\n");
  f.git("add", "src/");
  f.git("commit", "-qm", "advance target");
  await rm(tool.tool);
  await writeFile(
    review.report,
    JSON.stringify({
      ticket: "A",
      attempt: 1,
      revision: review.revision,
      base: review.base,
      stage: "post-graft",
      kind: "pass",
      findings: [],
    }),
  );
  const changed = (await f.tick("reconcile")).runs.A;
  expect(changed).toMatchObject({
    kind: "running",
    attempt: 2,
    checks: { results: [{ name: "local", status: "fail" }] },
  });
  const gates = factoryEvidence(f.factory.directory, "A")!.filter(
    (row) => row.kind === "gate",
  );
  expect(gates.map((row) => row.outcome)).toEqual([
    "gate-passed",
    "gate-failed",
  ]);
  expect(gates[0]!.revision).toBe(review.revision);
  expect(gates[1]!.revision).not.toBe(review.revision);
  expect(await readFile(tool.count, "utf8")).toBe("version\ncheck\n");
});

test("every check runs after earlier failures, and one rejection names each failure with its own tail", async () => {
  const f = await checkedEngine({
    first: "command: echo FIRST-OUT; exit 3\norder: 1\n",
    second: "command: echo SECOND-OUT\norder: 2\n",
    third: "command: echo THIRD-ERR >&2; exit 4\norder: 3\n",
  });
  const result = await submit(f, "src/keep.ts");
  expect(result.runs.A).toMatchObject({
    kind: "running",
    attempt: 2,
    checks: {
      attempt: 1,
      results: [
        { name: "first", required: true, status: "fail" },
        { name: "second", required: true, status: "pass" },
        { name: "third", required: true, status: "fail" },
      ],
    },
  });
  const feedback = f.sent.at(-1)!.split("Repair the candidate")[0]!;
  expect(feedback).toContain("Gate failed twice");
  expect(feedback).toMatch(/- first: fail in \d+ms/);
  expect(feedback).toMatch(/- second: pass in \d+ms/);
  expect(feedback).toMatch(/- third: fail in \d+ms/);
  expect(feedback).toContain(
    "BEGIN first STDOUT\nFIRST-OUT\n\nEND first STDOUT",
  );
  expect(feedback).toContain(
    "BEGIN third STDERR\nTHIRD-ERR\n\nEND third STDERR",
  );
  expect(feedback).not.toContain("BEGIN second");
  expect(feedback).not.toContain("SECOND-OUT");
});

const advisory = {
  test: `command: "echo 'error: FAILED 3 tests'"\norder: 1\n`,
  style: "command: echo ADVISORY-OUT; exit 1\norder: 2\nrequired: false\n",
};

test("an advisory failure is accepted without a worker message and kept in evidence; the pass rule ignores output", async () => {
  const f = await checkedEngine(advisory);
  const result = await submit(f, "src/keep.ts");
  expect(result.runs.A).toMatchObject({
    kind: "done",
    checks: {
      attempt: 1,
      results: [
        { name: "test", required: true, status: "pass" },
        { name: "style", required: false, status: "fail" },
      ],
    },
  });
  // Only the dispatch prompt reached the worker; acceptance sends nothing to act on.
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).not.toContain("BEGIN style");
  const rows = factoryEvidence(f.factory.directory, "A")!;
  const gate = rows.find((row) => row.kind === "gate")!;
  expect(gate.outcome).toBe("gate-passed");
  const content = JSON.parse(
    evidenceContent(f.factory.directory, "A", gate.sha256),
  );
  expect(content.checks).toMatchObject([
    { name: "test", required: true, status: "pass" },
    {
      name: "style",
      required: false,
      status: "fail",
      outputTail: { stdout: "ADVISORY-OUT\n" },
    },
  ]);
});

test("a gate rejection carries a failed advisory check's tail beside the required failure", async () => {
  const f = await checkedEngine({
    ...advisory,
    test: "command: echo REQUIRED-OUT; exit 1\norder: 1\n",
  });
  const result = await submit(f, "src/keep.ts");
  expect(result.runs.A).toMatchObject({ kind: "running", attempt: 2 });
  const feedback = f.sent.at(-1)!.split("Repair the candidate")[0]!;
  expect(feedback).toContain("BEGIN test STDOUT\nREQUIRED-OUT\n");
  expect(feedback).toContain("BEGIN style STDOUT\nADVISORY-OUT\n");
  expect(feedback).toMatch(/- style \(advisory\): fail in \d+ms/);
});

test("a review rejection of a passed gate carries each failed advisory check's tail", async () => {
  const f = await checkedEngine({
    ...advisory,
    docs: "command: echo DOCS-PASS\norder: 3\nrequired: false\n",
  });
  await put(f.root, { "agents/reviewer/agent.md": "---\n---\n" });
  f.git("add", "-A");
  f.git("commit", "-qm", "review on");
  const run = (await submit(f, "src/keep.ts")).runs.A;
  if (run?.kind !== "running" || !run.review)
    throw new Error("Expected a candidate in review");
  f.host.state = async () => "idle";
  await f.tick("reconcile");
  const review = (await f.tick("reconcile")).runs.A;
  if (review?.kind !== "running" || !review.review)
    throw new Error("Expected a sent review");
  const finding = {
    severity: "warning",
    location: "src/keep.ts:1",
    evidence: "REVIEW-FINDING",
    correction: "Fix it",
  };
  await writeFile(
    review.review.report,
    JSON.stringify({
      ticket: "A",
      attempt: 1,
      revision: review.review.revision,
      base: review.review.base,
      stage: "post-graft",
      kind: "issues",
      findings: [finding],
    }),
  );
  const rejected = (await f.tick("reconcile")).runs.A;
  expect(rejected).toMatchObject({
    kind: "running",
    attempt: 2,
    rejectedBy: "review",
  });
  const feedback = f.sent.at(-1)!.split("Repair the candidate")[0]!;
  expect(feedback).toContain("REVIEW-FINDING");
  expect(feedback).toContain(
    "BEGIN style (advisory, fail) STDOUT\nADVISORY-OUT\n",
  );
  expect(feedback).not.toContain("DOCS-PASS");
  expect(feedback).not.toContain("BEGIN test");
});

test("a required check that times out, is killed or cannot start fails, and later checks still run", async () => {
  const f = await checkedEngine({
    slow: "command: sleep 5\norder: 1\ntimeoutMs: 300\n",
    killed: "command: kill -9 $$\norder: 2\n",
    missing: "command: /nonexistent/factory-check\norder: 3\n",
    after: "command: echo AFTER-RAN\norder: 4\n",
  });
  const result = await submit(f, "src/keep.ts");
  expect(result.runs.A).toMatchObject({
    kind: "running",
    attempt: 2,
    checks: {
      results: [
        { name: "slow", status: "timeout" },
        { name: "killed", status: "fail" },
        { name: "missing", status: "fail" },
        { name: "after", status: "pass" },
      ],
    },
  });
  const feedback = f.sent.at(-1)!;
  expect(feedback).toMatch(/- slow: timeout in \d+ms/);
  expect(feedback).toContain("Command timed out after 300ms");
  // A gate with a killed or timed-out check has no exit status, so it is not rerun.
  expect(feedback).not.toContain("Gate failed twice");
  expect(
    await readFile(join(f.factory.directory, "A-1.log"), "utf8"),
  ).toContain("AFTER-RAN");
});

test("a check added or edited without reload does not change the active run's pinned gate", async () => {
  const f = await checkedEngine(passing);
  const run = (await f.tick("start")).runs.A;
  if (run?.kind !== "running") throw new Error("Expected a running worker");
  await put(f.root, {
    "checks/test.yaml": "command: exit 1\norder: 1\n",
    "checks/extra.yaml": "command: exit 9\norder: 2\n",
  });
  f.git("add", "-A");
  f.git("commit", "-qm", "edit checks");
  expect((await configuration(f.root)).checks?.map((c) => c.name)).toEqual([
    "test",
    "extra",
  ]);
  expect((await effectiveConfiguration(f.root)).checks).toEqual([
    { name: "test", command: "echo ok", required: true, timeoutMs: 600_000 },
  ]);
  expect(
    factoryDefinition(f.factory.directory, run.definition)?.checks,
  ).toEqual([
    { name: "test", command: "echo ok", required: true, timeoutMs: 600_000 },
  ]);
});

test("the feed carries check names and statuses, never commands or output", async () => {
  const canary = "CHECK-OUTPUT-CANARY";
  const f = await checkedEngine({
    test: `command: echo ${canary}; exit 2\norder: 1\n`,
    style: `command: echo ${canary}\norder: 2\nrequired: false\n`,
  });
  await submit(f, "src/keep.ts");
  const server = startDashboard({ root: f.root, port: 0 });
  try {
    const text = await (
      await fetch(`http://localhost:${server.port}/api/status`)
    ).text();
    expect(text).not.toContain(canary);
    expect(text).not.toContain("echo");
    const task = JSON.parse(text).tasks.find(
      (row: { id: string }) => row.id === "A",
    );
    expect(task.checks).toEqual({
      attempt: 1,
      results: [
        { name: "test", required: true, status: "fail" },
        { name: "style", required: false, status: "pass" },
      ],
    });
  } finally {
    await server.stop(true);
  }
});

// A coordinator killed mid-check leaves its check running; restarted coordinators with a fixed
// clock must keep it before its own saved deadline and kill it after.
test.each([
  ["shorter", 2000],
  ["longer", 1_200_000],
])(
  "recovery enforces a %s check timeout saved with the check's process",
  async (_name, timeoutMs) => {
    const f = await checkedEngine({});
    const marks = join(f.root, ".git");
    await put(f.root, {
      "checks/hang.yaml": `command: touch '${marks}/check-running'; sleep 30\norder: 1\ntimeoutMs: ${timeoutMs}\n`,
    });
    f.git("add", "-A");
    f.git("commit", "-qm", "hanging check");
    await f.tick("start");
    const worktree = join(marks, "factory/worktrees/A");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", worktree, ...args], {
        encoding: "utf8",
      }).trim();
    await writeFile(join(worktree, "src/keep.ts"), "export {}; //\n");
    git("commit", "-qam", "candidate");
    const directory = f.factory.directory;
    await writeFile(
      join(directory, "A.report.json"),
      JSON.stringify({
        attempt: 1,
        kind: "candidate",
        revision: git("rev-parse", "HEAD"),
        insight: "Verified candidate",
      }),
    );
    const runner = join(marks, "coordinator.ts");
    await writeFile(
      runner,
      `import {createFactory} from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
import {openStore} from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
await createFactory(${JSON.stringify(f.root)}, {
  async create() { throw new Error("Must not create"); },
  async send() {}, async state() { return "idle"; }, watch() {}
}, openStore).tick("reconcile", "T-owner");`,
    );
    const child = spawn("bun", [runner], { stdio: "ignore" });
    for (let i = 0; i < 2000 && !existsSync(join(marks, "check-running")); i++)
      await Bun.sleep(5);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const held = factoryStatus(directory).runs.A;
    if (held?.kind !== "running" || !held.gate)
      throw new Error("Expected a saved gate marker");
    const { at, pid, deadline } = held.gate;
    expect(deadline).toBe(at + timeoutMs);
    const alive = () =>
      spawnSync("bash", ["-c", `kill -0 -- -${pid}`]).status === 0;
    const restart = (clock: number) =>
      createFactory(f.root, f.host, openStore, () => clock).tick(
        "reconcile",
        "T-owner",
      );
    try {
      // Just before its own deadline the check keeps running, also past the default 600000 ms
      // for the longer timeout.
      await restart(deadline! - 1);
      expect(alive()).toBe(true);
      expect(factoryStatus(directory).runs.A).toMatchObject({
        gate: { pid, deadline },
      });
      await restart(deadline! + 1);
      const stopped = spawnSync("bash", [
        "-c",
        `for i in {1..500}; do kill -0 -- -${pid} 2>/dev/null || exit 0; sleep 0.01; done; exit 1`,
      ]);
      expect(stopped.status).toBe(0);
      expect(
        (factoryEvents(directory, 0, 500) ?? [])
          .filter((event) => event.action === "gate-killed")
          .map((event) => event.detail),
      ).toEqual(["1"]);
    } finally {
      spawnSync("bash", ["-c", `kill -9 -- -${pid} 2>/dev/null`]);
    }
  },
);
