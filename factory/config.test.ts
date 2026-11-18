import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
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
  configuration,
  createFactory,
  effectiveConfiguration,
  effectiveDefinition,
  migrateDefinition,
  type NativeHost,
} from "./native";
import { factoryDefinition } from "./persistence";

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
  orchestratorModel: "openai/gpt-6.1-sol",
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
    "---\nmodel: openai/gpt-6.1-sol\n---\n# Foreman\n\nOrchestrate.\n",
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
    "a Foreman prompt with valid model front matter",
    {
      "agents/foreman/agent.md":
        "---\nmodel: openai/gpt-6.1-sol\n---\n# Foreman\n",
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
  expect(migrated).toMatch(/^---\nmodel: openai\/gpt-6\.1-sol\n---\n/);
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
