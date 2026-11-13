import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuration, createFactory, tasks, type NativeHost } from "./native";
import { openStore } from "./bookkeeping.fixture";

const installer = resolve(import.meta.dir, "setup-factory.ts");
const preparationRoots: string[] = [];

test("queue retains ordered step labels and rejects malformed labels", () => {
  const task = { id: "A", brief: "Private brief", after: [] };
  expect(
    tasks([
      {
        ...task,
        steps: [
          "Verify private field exclusion",
          "Preserve ordered task labels",
        ],
      },
    ])[0],
  ).toMatchObject({
    steps: ["Verify private field exclusion", "Preserve ordered task labels"],
  });
  expect(Object.hasOwn(tasks([task])[0]!, "steps")).toBe(false);
  expect(tasks([{ ...task, steps: [] }])[0]?.steps).toEqual([]);
  for (const steps of [
    null,
    "Label",
    {},
    [""],
    [" \t"],
    [7],
    ["Valid label", null],
  ])
    expect(() => tasks([{ ...task, steps }])).toThrow();
});

async function waitForFile(path: string) {
  for (let i = 0; i < 200 && !(await Bun.file(path).exists()); i++)
    await Bun.sleep(5);
  expect(await Bun.file(path).exists()).toBe(true);
}

function waitingSetup(root: string) {
  return `echo setup-started; touch '${root}/.git/setup-running'; for i in {1..500}; do test -f '${root}/.git/release' && break; sleep 0.01; done; test -f '${root}/.git/release' || exit 1; `;
}

async function preparationFixture(
  setup: (root: string) => string,
  timeoutMs = 60000,
) {
  const root = await mkdtemp(join(tmpdir(), "factory-preparation-"));
  preparationRoots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  for (const file of ["package.json", "bun.lock", "lefthook.yml"])
    await copyFile(join(import.meta.dir, "..", file), join(root, file));
  await writeFile(join(root, "prd.md"), "Fixture");
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(
    join(root, "tickets.json"),
    JSON.stringify([{ id: "A", brief: "Work", after: [] }]),
  );
  await writeFile(
    join(root, ".factory.json"),
    JSON.stringify({
      version: 1,
      capacity: 1,
      workerModel: "openai/gpt-6.1-sol",
      prd: "prd.md",
      tickets: "tickets.json",
      scope: ["src/"],
      verify: "true",
      setup: `${setup(root)}mkdir -p node_modules && printf prepared > node_modules/ready`,
      setupTimeoutMs: timeoutMs,
      permissions: { execute: true, publish: false, externalTickets: false },
    }),
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const worktree = join(root, ".git/factory/worktrees/A");
  let creates = 0;
  let sends = 0;
  const ready = async () =>
    expect(await readFile(join(worktree, "node_modules/ready"), "utf8")).toBe(
      "prepared",
    );
  const host: NativeHost = {
    async create() {
      await ready();
      creates++;
      return "T-prepared";
    },
    async send() {
      await ready();
      sends++;
    },
    async state() {
      return "running";
    },
    watch() {},
  };
  const factory = () => createFactory(root, host, openStore);
  return {
    root,
    worktree,
    host,
    factory,
    git,
    counts: () => ({ creates, sends }),
  };
}

afterEach(async () => {
  for (const root of preparationRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test.each(["", "bun install --frozen-lockfile && "])(
  "setup %s finishes before worker creation and delivery",
  async (command) => {
    const f = await preparationFixture(() => command);
    expect(
      await Bun.file(join(f.worktree, "node_modules/ready")).exists(),
    ).toBe(false);
    const factory = f.factory();
    await Promise.all([
      factory.tick("start", "T-owner"),
      factory.tick("reconcile"),
    ]);
    await f.factory().tick("reconcile");
    expect((await factory.tick("status")).runs.A).toMatchObject({
      kind: "running",
      attempt: 1,
      worktree: f.worktree,
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    if (command) {
      expect(
        await Bun.file(
          join(f.worktree, "node_modules/oxlint/package.json"),
        ).exists(),
      ).toBe(true);
      expect(await readFile(join(f.worktree, "bun.lock"), "utf8")).toBe(
        await readFile(join(f.root, "bun.lock"), "utf8"),
      );
    }
  },
  90000,
);

test.each(
  ["setup", "gate"].flatMap((stage) =>
    ["none", "SSH_CLIENT", "SSH2_CLIENT"].map((ssh) => ({ stage, ssh })),
  ),
)(
  "$stage preserves nested Bash dependency lookup with $ssh and noninteractive stdin",
  async ({ stage, ssh }) => {
    const saved = {
      SSH_CLIENT: process.env.SSH_CLIENT,
      SSH2_CLIENT: process.env.SSH2_CLIENT,
    };
    delete process.env.SSH_CLIENT;
    delete process.env.SSH2_CLIENT;
    if (ssh !== "none") process.env[ssh] = "controlled-shell-fixture";
    try {
      const f = await preparationFixture(() => "");
      const home = join(f.root, ".git/shell-home");
      await mkdir(join(home, "bin"), { recursive: true });
      await writeFile(
        join(home, ".bashrc"),
        'echo startup-interference >> "$HOME/startup-marker"\nexport PATH=/usr/bin:/bin\n',
      );
      const dependency = join(home, "bin/factory-fixture-dependency");
      await writeFile(
        dependency,
        "#!/bin/sh\nif read -r input; then exit 1; fi\necho dependency-ready\n",
      );
      await chmod(dependency, 0o755);
      const command = `env SHLVL=0 HOME='${home}' PATH='${home}/bin:/usr/bin:/bin' bash -c 'factory-fixture-dependency'`;
      const configPath = join(f.root, ".factory.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (stage === "setup") config.setup = `${command} && ${config.setup}`;
      else config.verify = command;
      await writeFile(configPath, JSON.stringify(config));
      f.git("add", ".factory.json");
      f.git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "configure nested shell",
      );
      const factory = f.factory();
      expect((await factory.tick("start", "T-owner")).runs.A).toMatchObject({
        kind: "running",
        attempt: 1,
      });
      await mkdir(join(f.worktree, "src"));
      await writeFile(join(f.worktree, "src/value"), "good");
      f.git("-C", f.worktree, "add", "src/value");
      f.git(
        "-C",
        f.worktree,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "candidate",
      );
      const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
      await writeFile(
        join(factory.directory, "A.report.json"),
        JSON.stringify({ kind: "candidate", attempt: 1, revision }),
      );
      f.host.state = async () => "idle";
      expect((await factory.tick("reconcile")).runs.A).toMatchObject({
        kind: "done",
        revision,
      });
      expect(await Bun.file(join(home, "startup-marker")).exists()).toBe(false);
      if (stage === "gate")
        expect(await readFile(join(factory.directory, "A-1.log"), "utf8")).toBe(
          "dependency-ready\n",
        );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.each([
  { command: "touch setup-marker; ", path: "setup-marker", content: "" },
  { command: "printf x >> prd.md; ", path: "prd.md", content: "Fixturex" },
])(
  "setup leaving $path dirty fails before worker creation",
  async ({ command, path, content }) => {
    const f = await preparationFixture(() => command);
    const failed = (await f.factory().tick("start", "T-owner")).runs.A;
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    expect(failed).toMatchObject({
      kind: "preparation-failed",
      reason: expect.stringContaining(path),
    });
    expect(failed).not.toHaveProperty("attempt");
    expect(await readFile(join(f.worktree, path), "utf8")).toBe(content);
    expect((await f.factory().tick("reconcile")).runs.A).toEqual(failed);
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  },
);

test("pre-existing non-worktree directory is preserved without setup or a worker", async () => {
  const f = await preparationFixture(
    (root) => `touch '${root}/.git/setup-started'; `,
  );
  await mkdir(f.worktree, { recursive: true });
  const note = join(f.worktree, "operator-note");
  await writeFile(note, "preserve this directory");
  const failed = (await f.factory().tick("start", "T-owner")).runs.A;
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  expect(failed).toMatchObject({ kind: "preparation-failed" });
  expect(failed).not.toHaveProperty("attempt");
  expect(await Bun.file(join(f.root, ".git/setup-started")).exists()).toBe(
    false,
  );
  expect(await readFile(note, "utf8")).toBe("preserve this directory");
  expect(
    (await f.factory().tick("retry-setup", "T-owner")).runs.A,
  ).toMatchObject({
    kind: "preparation-failed",
  });
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
});

test.each([
  {
    command: "echo missing-dependencies >&2; exit 23",
    timeout: 60000,
    evidence: "missing-dependencies",
  },
  {
    command: "echo waiting-for-dependencies; sleep 5",
    timeout: 100,
    evidence: "timed out after 100ms",
  },
])(
  "failed setup retains $evidence and explicitly recovers at attempt one",
  async ({ command, timeout, evidence }) => {
    const f = await preparationFixture(
      (root) => `test -f '${root}/.git/release' || { ${command}; }; `,
      timeout,
    );
    const failed = (await f.factory().tick("start", "T-owner")).runs.A;
    if (failed?.kind !== "preparation-failed")
      throw new Error("Expected failed preparation");
    expect("attempt" in failed).toBe(false);
    expect(failed.pid).toBeUndefined();
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    const log = await readFile(failed.log, "utf8");
    expect(log).toContain(evidence);
    const reopened = f.factory();
    await Promise.all([
      reopened.tick("reconcile"),
      f.factory().tick("reconcile"),
    ]);
    expect((await reopened.tick("status")).runs.A).toEqual(failed);
    const configPath = join(f.root, ".factory.json");
    const config = await Bun.file(configPath).json();
    config.setup =
      "mkdir -p node_modules && printf prepared > node_modules/ready";
    config.setupTimeoutMs = 60000;
    await writeFile(configPath, JSON.stringify(config));
    expect(reopened.tick("retry-setup", "T-owner")).rejects.toThrow(
      "Commit existing changes",
    );
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    expect((await reopened.tick("status")).runs.A).toEqual(failed);
    f.git("add", ".factory.json");
    f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fix setup",
    );
    const base = f.git("rev-parse", "HEAD");
    const worktreeConfig = join(f.worktree, ".factory.json");
    const saved = await readFile(worktreeConfig, "utf8");
    await writeFile(worktreeConfig, `${saved}\n`);
    expect(reopened.tick("retry-setup", "T-owner")).rejects.toThrow(
      "Preparation worktree has local changes",
    );
    expect(await readFile(worktreeConfig, "utf8")).toBe(`${saved}\n`);
    expect((await reopened.tick("status")).runs.A).toEqual(failed);
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
    await writeFile(worktreeConfig, saved);
    const retries = await Promise.allSettled([
      reopened.tick("retry-setup", "T-owner"),
      reopened.tick("retry-setup", "T-owner"),
      reopened.tick("reconcile"),
    ]);
    expect(retries[0]?.status).toBe("fulfilled");
    expect(retries[1]?.status).toBe("rejected");
    expect((await reopened.tick("status")).runs.A).toMatchObject({
      kind: "running",
      attempt: 1,
      base,
      worktree: failed.worktree,
    });
    expect(f.counts()).toEqual({ creates: 1, sends: 1 });
    expect(await readFile(failed.log, "utf8")).toBe(log);
    await mkdir(join(f.worktree, "src"));
    await writeFile(join(f.worktree, "src/value"), "good");
    f.git("-C", f.worktree, "add", "src/value");
    f.git(
      "-C",
      f.worktree,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "candidate",
    );
    const revision = f.git("-C", f.worktree, "rev-parse", "HEAD");
    await writeFile(
      join(reopened.directory, "A.report.json"),
      JSON.stringify({ kind: "candidate", attempt: 1, revision }),
    );
    f.host.state = async () => "idle";
    expect((await reopened.tick("reconcile")).runs.A).toMatchObject({
      kind: "done",
      revision,
    });
    expect(f.git("rev-parse", "HEAD")).toBe(revision);
    expect(await readFile(join(f.root, "src/value"), "utf8")).toBe("good");
  },
);

test("setup timeout releases inherited pipes from escaped descendants", async () => {
  const f = await preparationFixture(
    (root) =>
      `setsid bash -c 'echo $$ > ${root}/.git/escaped-pid; exec sleep 30' & `,
    500,
  );
  const starting = f.factory().tick("start", "T-owner");
  try {
    const result = await Promise.race([
      starting,
      Bun.sleep(3000).then(() => {
        throw new Error("Setup timeout did not release the coordinator");
      }),
    ]);
    expect(result.runs.A).toMatchObject({ kind: "preparation-failed" });
    expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  } finally {
    const pid = Number(
      await readFile(join(f.root, ".git/escaped-pid"), "utf8"),
    );
    process.kill(-pid, "SIGKILL");
    await starting;
  }
});

test("concurrent reconcile and explicit recovery cannot overlap live setup", async () => {
  const f = await preparationFixture(waitingSetup);
  const starting = f.factory().tick("start", "T-owner");
  await waitForFile(join(f.root, ".git/setup-running"));
  const reopened = f.factory();
  expect((await reopened.tick("reconcile")).runs.A?.kind).toBe("preparing");
  const retry = await reopened.tick("retry-setup", "T-owner").then(
    () => "overlapped",
    (error: unknown) => String(error),
  );
  expect(retry).toContain("still alive");
  expect(f.counts()).toEqual({ creates: 0, sends: 0 });
  await writeFile(join(f.root, ".git/release"), "ready");
  expect((await starting).runs.A).toMatchObject({
    kind: "running",
    attempt: 1,
    worktree: f.worktree,
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("coordinator process death parks setup until explicit recovery in the same worktree", async () => {
  const f = await preparationFixture(waitingSetup);
  const runner = join(f.root, ".git/coordinator.ts");
  await writeFile(
    runner,
    `import {createFactory} from ${JSON.stringify(join(import.meta.dir, "native.ts"))};
import {openStore} from ${JSON.stringify(join(import.meta.dir, "bookkeeping.fixture.ts"))};
await createFactory(${JSON.stringify(f.root)}, {
  async create() { throw new Error("Must not create before coordinator stops"); },
  async send() {}, async state() { return "running"; }, watch() {}
}, openStore).tick("start", "T-owner");`,
  );
  const child = spawn("bun", [runner], { stdio: "ignore" });
  await waitForFile(join(f.root, ".git/setup-running"));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  const factory = f.factory();
  const parked = (await factory.tick("reconcile")).runs.A;
  if (parked?.kind !== "preparing")
    throw new Error("Expected interrupted preparation");
  expect(await readFile(parked.log, "utf8")).toContain("setup-started");
  expect(factory.tick("retry-setup", "T-owner")).rejects.toThrow("still alive");
  await writeFile(join(f.root, ".git/release"), "ready");
  await waitForFile(join(f.worktree, "node_modules/ready"));
  const stopped = spawnSync("bash", [
    "-c",
    `for i in {1..200}; do kill -0 -- -${parked.pid} 2>/dev/null || exit 0; sleep 0.01; done; exit 1`,
  ]);
  expect(stopped.status).toBe(0);
  expect((await factory.tick("reconcile")).runs.A).toEqual(parked);
  expect((await factory.tick("retry-setup", "T-owner")).runs.A).toMatchObject({
    kind: "running",
    attempt: 1,
    worktree: f.worktree,
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 1 });
});

test("successful setup never retries ambiguous worker creation", async () => {
  const f = await preparationFixture(() => "");
  const create = f.host.create.bind(f.host);
  f.host.create = async (...args) => {
    await create(...args);
    throw new Error("lost creation response");
  };
  expect(f.factory().tick("start", "T-owner")).rejects.toThrow(
    "lost creation response",
  );
  const reopened = f.factory();
  await reopened.tick("reconcile");
  await reopened.tick("retry-setup", "T-owner");
  expect((await reopened.tick("status")).runs.A).toMatchObject({
    kind: "creating",
    worktree: f.worktree,
  });
  expect(f.counts()).toEqual({ creates: 1, sends: 0 });
});

test("setup preserves application files and disabled configuration across two repositories", async () => {
  const home = await mkdtemp(join(tmpdir(), "factory-install-"));
  try {
    for (const name of ["first", "second"]) {
      const root = join(home, name);
      await mkdir(join(root, "docs"), { recursive: true });
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "docs/prd.md"), "# Existing application\n");
      await writeFile(join(root, "AGENTS.md"), "Keep this guidance.\n");
      const args = [
        installer,
        "--repo",
        root,
        "--prd",
        "docs/prd.md",
        "--verify",
        "true",
        "--scope",
        "src/",
        "--store",
        resolve(import.meta.dir, "bookkeeping.fixture.ts"),
      ];
      const before = spawnSync("bun", [...args, "--check"], {
        encoding: "utf8",
      });
      expect(before.status).toBe(1);
      expect(await Bun.file(join(root, ".factory.json")).exists()).toBe(false);
      const install = spawnSync("bun", args, { encoding: "utf8" });
      expect(install.stderr).toBe("");
      expect(install.status).toBe(0);
      const configPath = join(root, ".factory.json");
      const config = await Bun.file(configPath).json();
      expect(config.workerModel).toBe("openai/gpt-6.1-sol");
      expect(config.workerEffort).toBe("medium");
      expect(config.permissions).toEqual({
        execute: false,
        publish: false,
        externalTickets: false,
      });
      expect(
        await Bun.file(join(root, ".amp/plugins/software-factory.js")).exists(),
      ).toBe(true);
      config.mode = "ui-polish";
      await writeFile(configPath, JSON.stringify(config));
      const preserved = await readFile(configPath, "utf8");
      expect(spawnSync("bun", args, { encoding: "utf8" }).status).toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(preserved);
      expect(
        spawnSync("bun", [...args, "--check"], { encoding: "utf8" }).status,
      ).toBe(0);
      expect(await readFile(join(root, "docs/prd.md"), "utf8")).toBe(
        "# Existing application\n",
      );
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
        "Keep this guidance.\n",
      );
      expect(
        await Bun.file(join(root, ".git/factory/state.json")).exists(),
      ).toBe(false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("unknown remote creation or delivery never starts replacement or independent workers", async () => {
  for (const failure of ["create", "send"]) {
    const root = await mkdtemp(join(tmpdir(), "factory-unknown-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      expect(
        spawnSync(
          "bun",
          [
            installer,
            "--repo",
            root,
            "--prd",
            "prd.md",
            "--verify",
            "true",
            "--scope",
            "src/",
            "--store",
            resolve(import.meta.dir, "bookkeeping.fixture.ts"),
          ],
          { encoding: "utf8" },
        ).status,
      ).toBe(0);
      const config = await Bun.file(join(root, ".factory.json")).json();
      config.permissions.execute = true;
      await writeFile(join(root, ".factory.json"), JSON.stringify(config));
      await writeFile(
        join(root, ".factory-tickets.json"),
        JSON.stringify([
          { id: "X", brief: "First", after: [] },
          { id: "Y", brief: "Independent", after: [] },
        ]),
      );
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      let creates = 0;
      let sends = 0;
      const host: NativeHost = {
        async create() {
          creates++;
          if (failure === "create") throw new Error("lost creation response");
          return "T-unknown";
        },
        async send() {
          sends++;
          throw new Error("lost delivery response");
        },
        async state() {
          return "running";
        },
        watch() {},
      };
      expect(
        createFactory(root, host, openStore).tick("start", "T-owner"),
      ).rejects.toThrow(/lost/);
      const reopened = createFactory(root, host, openStore);
      await reopened.tick("reconcile");
      await reopened.tick("reconcile");
      expect(creates).toBe(1);
      expect(sends).toBe(failure === "create" ? 0 : 1);
      expect((await reopened.tick("status")).runs.Y).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test.each(["high", undefined])(
  "native dispatch preserves effort %s, same-worker correction, and recovery",
  async (effort) => {
    const root = await mkdtemp(join(tmpdir(), "factory-dispatch-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Factory fixture");
      git("config", "user.email", "fixture@example.invalid");
      await mkdir(join(root, "src"));
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      await writeFile(join(root, "src/value"), "old");
      await writeFile(
        join(root, "check.cjs"),
        "if(require('fs').readFileSync('src/value','utf8') !== 'good') process.exit(1)",
      );
      expect(
        spawnSync(
          "bun",
          [
            installer,
            "--repo",
            root,
            "--prd",
            "prd.md",
            "--verify",
            "node check.cjs",
            "--scope",
            "src/",
            "--store",
            resolve(import.meta.dir, "bookkeeping.fixture.ts"),
          ],
          { encoding: "utf8" },
        ).status,
      ).toBe(0);
      const config = await Bun.file(join(root, ".factory.json")).json();
      config.permissions.execute = true;
      if (effort === undefined) delete config.workerEffort;
      else config.workerEffort = effort;
      await writeFile(join(root, ".factory.json"), JSON.stringify(config));
      const savedConfig = await readFile(join(root, ".factory.json"), "utf8");
      expect((await configuration(root)).workerEffort).toBe(effort);
      expect(await readFile(join(root, ".factory.json"), "utf8")).toBe(
        savedConfig,
      );
      await writeFile(
        join(root, ".factory-tickets.json"),
        JSON.stringify([
          { id: "A", brief: "Repair value", after: [] },
          { id: "B", brief: "Dependent", after: ["A"] },
          { id: "C", brief: "Independent", after: [] },
        ]),
      );
      git("add", ".");
      git("commit", "-qm", "fixture baseline");
      const messages: { id: string; text: string }[] = [];
      const settings: Parameters<NativeHost["create"]>[] = [];
      let created = 0;
      const host: NativeHost = {
        async create(...args) {
          settings.push(args);
          created++;
          return `T-fixture-${created}`;
        },
        async send(id, text) {
          messages.push({ id, text });
        },
        async state() {
          return "idle";
        },
        watch() {},
      };
      let factory = createFactory(root, host, openStore);
      await Promise.all([
        factory.tick("start", "T-owner"),
        factory.tick("reconcile"),
      ]);
      expect(
        (await readFile(join(factory.directory, "state.sqlite")))
          .subarray(0, 16)
          .toString(),
      ).toBe("SQLite format 3\u0000");
      expect(created).toBe(1);
      expect(settings).toEqual([["T-owner", "openai/gpt-6.1-sol", effort]]);
      const worktree = join(root, ".git/factory/worktrees/A");
      expect(await Bun.file(join(worktree, "src/value")).exists()).toBe(true);
      const candidate = async (
        value: string,
        attempt: number,
        insight = "",
      ) => {
        await writeFile(join(worktree, "src/value"), value);
        execFileSync("git", ["-C", worktree, "add", "src/value"]);
        execFileSync("git", [
          "-C",
          worktree,
          "commit",
          "-qm",
          `candidate ${attempt}`,
        ]);
        const revision = execFileSync(
          "git",
          ["-C", worktree, "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim();
        await writeFile(
          join(factory.directory, "A.report.json"),
          JSON.stringify({ kind: "candidate", attempt, revision, insight }),
        );
      };
      await candidate("bad", 1);
      await writeFile(
        join(root, ".factory.json"),
        JSON.stringify({ ...config, workerEffort: "max" }),
      );
      await factory.tick("reconcile");
      expect(created).toBe(1);
      expect(messages.map((message) => message.id)).toEqual([
        "T-fixture-1",
        "T-fixture-1",
      ]);
      await writeFile(join(root, ".factory.json"), savedConfig);
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
      await candidate("still bad", 2);
      await factory.tick("reconcile");
      await factory.tick("pause");
      factory = createFactory(root, host, openStore);
      expect((await factory.tick("status")).runs.A?.kind).toBe("blocked");
      const repair = {
        ticket: "A",
        decision: "Correct the value contract, retaining this worker",
      };
      expect(
        factory.tick("resume", "T-fixture-1", host.state, repair),
      ).rejects.toThrow();
      expect(
        factory.tick("resume", "T-stranger", host.state, repair),
      ).rejects.toThrow();
      expect(
        factory.tick("resume", "T-owner", host.state, {
          ...repair,
          decision: "  ",
        }),
      ).rejects.toThrow(/nonempty/);
      await writeFile(join(worktree, "unexpected"), "setup dirt");
      expect(
        factory.tick("resume", "T-owner", host.state, repair),
      ).rejects.toThrow(/changed/);
      await rm(join(worktree, "unexpected"));
      await writeFile(join(root, "unexpected"), "integration dirt");
      expect(
        factory.tick("resume", "T-owner", host.state, repair),
      ).rejects.toThrow(/changed/);
      await rm(join(root, "unexpected"));
      const resumed = await Promise.allSettled([
        factory.tick("resume", "T-owner", host.state, repair),
        factory.tick("resume", "T-owner", host.state, repair),
      ]);
      expect(resumed.map((result) => result.status)).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect((await factory.tick("status")).enabled).toBe(false);
      expect(created).toBe(1);
      expect(messages).toHaveLength(2);
      host.state = async () => "unknown";
      expect(factory.tick("start", "T-owner")).rejects.toThrow(/idle/);
      host.state = async () => "idle";
      const base = git("rev-parse", "HEAD");
      git("commit", "--allow-empty", "-qm", "base changed while paused");
      expect(factory.tick("reconcile")).rejects.toThrow(/changed/);
      expect(messages).toHaveLength(2);
      git("reset", "--hard", base);
      await factory.tick("start", "T-owner");
      expect(messages[2]?.id).toBe("T-fixture-1");
      await candidate("almost good", 3);
      await writeFile(join(worktree, "src/value"), "unfinished edit");
      await writeFile(join(worktree, "unexpected"), "unfinished file");
      expect((await factory.tick("reconcile")).runs.A).toMatchObject({
        kind: "running",
        thread: "T-fixture-1",
        attempt: 4,
        delivery: "sent",
      });
      expect(messages[3]).toMatchObject({
        id: "T-fixture-1",
        text: expect.stringMatching(
          /Verification rejected attempt 3.*submit report attempt 4/,
        ),
      });
      expect(await readFile(join(worktree, "src/value"), "utf8")).toBe(
        "unfinished edit",
      );
      expect(await readFile(join(worktree, "unexpected"), "utf8")).toBe(
        "unfinished file",
      );
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
      expect(created).toBe(1);
      factory = createFactory(root, host, openStore);
      await factory.tick("reconcile");
      expect(messages).toHaveLength(4);
      await rm(join(worktree, "unexpected"));
      await candidate("good", 4, "Use the shared value contract");
      factory = createFactory(root, host, openStore);
      const state = await factory.tick("reconcile");
      expect(state.runs.A?.kind).toBe("done");
      expect(await readFile(join(root, "src/value"), "utf8")).toBe("good");
      expect(created).toBe(2);
      expect(messages[4]?.text).toContain("Use the shared value contract");
      await writeFile(
        join(factory.directory, "B.report.json"),
        JSON.stringify({
          kind: "blocked",
          attempt: 1,
          reason: "Needs migration decision",
        }),
      );
      await factory.tick("reconcile");
      expect(created).toBe(3);
      expect(messages[5]?.text).not.toContain("Use the shared value contract");
      await Promise.all(
        Array.from({ length: 8 }, () => factory.tick("reconcile")),
      );
      expect(created).toBe(3);
      const db = new Database(join(factory.directory, "state.sqlite"), {
        readonly: true,
      });
      const events = db
        .query<{ ticket: string; action: string }, []>(
          "SELECT ticket, action FROM events",
        )
        .all();
      expect(
        db
          .query(
            "SELECT detail FROM events WHERE ticket = 'A' AND action = 'accepted'",
          )
          .all(),
      ).toEqual([{ detail: git("rev-parse", "HEAD") }]);
      db.close();
      expect(events.filter((event) => event.action === "creating")).toEqual([
        { ticket: "A", action: "creating" },
        { ticket: "B", action: "creating" },
        { ticket: "C", action: "creating" },
      ]);
      expect(
        events.filter(
          (event) => event.ticket === "B" && event.action === "blocked",
        ),
      ).toHaveLength(1);
      await factory.tick("pause");
      factory = createFactory(root, host, openStore);
      expect((await factory.tick("reconcile")).enabled).toBe(false);
      expect(created).toBe(3);
      expect(settings).toEqual(
        Array.from({ length: 3 }, () => [
          "T-owner",
          "openai/gpt-6.1-sol",
          effort,
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
