import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuration, createFactory, type NativeHost } from "./native";
import { startDashboard } from "./dashboard";
import { openPersistence } from "./persistence";

const installer = resolve(import.meta.dir, "setup-factory.ts");

test("two project definitions migrate explicitly, preserve metadata and expose only safe capabilities", async () => {
  const home = await mkdtemp(join(tmpdir(), "factory-definitions-"));
  try {
    const store = join(home, "store.ts");
    await writeFile(store, "export function openStore() {}\n");
    for (const [index, name] of ["first", "second"].entries()) {
      const root = join(home, name);
      await mkdir(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "prd.md"), `# Private instructions ${name}\n`);
      const run = (...flags: string[]) =>
        spawnSync("bun", [installer, "--repo", root, ...flags], {
          encoding: "utf8",
        });
      expect(
        run(
          "--prd",
          "prd.md",
          "--verify",
          "false",
          "--scope",
          "src/",
          "--store",
          store,
        ).status,
      ).toBe(0);
      const legacy = join(root, ".factory.json");
      const yaml = join(root, "factory/definition.yaml");
      const raw = await Bun.file(legacy).json();
      raw.verify = `touch '${root}/should-not-run'`;
      raw.setup = raw.verify;
      raw.setupTimeoutMs = 1234 + index;
      raw.scope = [index ? "lib/" : "src/"];
      raw.review = index === 0;
      raw.workerModel = index
        ? "anthropic/claude-sonnet-4.6"
        : "openai/gpt-6.1-sol";
      raw.mode = index ? "bug-finding" : "ui-polish";
      raw.permissions.execute = index === 0;
      if (index === 0) raw.permissions.backup = true;
      raw.backup = {
        repository: `private/${name}`,
        projectKey: `secret-${name}`,
      };
      await writeFile(legacy, JSON.stringify(raw, null, 2) + "\n");
      const before = await readFile(legacy, "utf8");
      const metadata = await stat(legacy);
      const persistence = openPersistence(join(root, ".git/factory"), []);
      persistence.commit(
        { enabled: false, owner: "T-existing-owner", runs: {} },
        "factory",
        "fixture",
        "private",
      );
      persistence.close();
      const database = join(root, ".git/factory/state.sqlite");
      const savedDatabase = await readFile(database);
      const resolved = await configuration(root);
      expect(run("--check").status).toBe(0);
      expect(await Bun.file(yaml).exists()).toBe(false);
      expect(run("--migrate").status).toBe(0);
      expect(await Bun.file(legacy).exists()).toBe(false);
      expect(await readFile(yaml, "utf8")).toBe(before);
      const migrated = await stat(yaml);
      expect([migrated.mode, migrated.uid, migrated.gid, migrated.ino]).toEqual(
        [metadata.mode, metadata.uid, metadata.gid, metadata.ino],
      );
      expect(await configuration(root)).toEqual(resolved);
      expect(run("--migrate").status).toBe(0);
      expect(run("--refresh", "--store", store).status).toBe(0);
      expect(await readFile(yaml, "utf8")).toBe(before);
      const effective = run("--effective");
      expect(effective.status).toBe(0);
      const safe = JSON.parse(effective.stdout);
      expect(safe).toEqual({
        version: 1,
        digest: resolved.digest,
        permissions: {
          execute: index === 0,
          backup: index === 0,
          publish: false,
          externalTickets: false,
        },
        capabilities: { review: index === 0, setup: true },
      });
      expect(effective.stdout).not.toContain("private/");
      expect(effective.stdout).not.toContain("secret-");
      expect(effective.stdout).not.toContain("touch");
      const server = startDashboard({ root, port: 0 });
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/definition`,
        );
        expect(await response.json()).toEqual(safe);
        expect(
          (await fetch(`http://127.0.0.1:${server.port}/api/status`)).status,
        ).toBe(200);
      } finally {
        await server.stop(true);
      }
      await link(yaml, legacy);
      expect(run("--check").status).toBe(1);
      expect(run("--migrate").status).toBe(0);
      await writeFile(legacy, before);
      expect(run("--migrate").status).toBe(1);
      expect(await readFile(yaml, "utf8")).toBe(before);
      await rm(legacy);
      const invalid = [
        { ...raw, version: 2 },
        { ...raw, hooks: [] },
        { ...raw, services: {} },
        { ...raw, prd: "missing.md" },
        { ...raw, tickets: "missing.json" },
        { ...raw, scope: ["../escape/"] },
        { ...raw, scope: ["./.git/"] },
        { ...raw, scope: ["factory/definition.yaml"] },
        { ...raw, permissions: { ...raw.permissions, publish: true } },
      ];
      await symlink(home, join(root, "escape"));
      invalid.push({ ...raw, prd: "escape/store.ts" });
      for (const value of invalid) {
        await writeFile(yaml, Bun.YAML.stringify(value));
        expect(run("--check").status).toBe(1);
        expect(run("--effective").status).toBe(1);
        expect(run("--migrate").status).toBe(1);
      }
      await writeFile(yaml, Bun.YAML.stringify(raw));
      expect((await configuration(root)).scope).toEqual(raw.scope);
      expect(run("--check").status).toBe(0);
      expect(await readFile(database)).toEqual(savedDatabase);
      expect(await Bun.file(join(root, "should-not-run")).exists()).toBe(false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

test("installer validates native effort before writes and dispatch rejects invalid saved effort", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-effort-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(join(root, "prd.md"), "# Fixture\n");
    const store = join(root, "store.ts");
    await writeFile(store, "export function openStore() {}\n");
    const args = [
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
      store,
    ];
    const run = (flags: string[]) =>
      spawnSync("bun", [...args, ...flags], { encoding: "utf8" });
    for (const effort of ["turbo", "", "HIGH"]) {
      expect(run(["--worker-effort", effort]).status).toBe(1);
      for (const file of [
        ".factory.json",
        ".factory-tickets.json",
        ".amp/plugins/software-factory.js",
      ])
        expect(await Bun.file(join(root, file)).exists()).toBe(false);
    }
    const configPath = join(root, ".factory.json");
    const host: NativeHost = {
      async create() {
        throw new Error("Worker must not be created");
      },
      async send() {},
      async state() {
        return "idle";
      },
      watch() {},
    };
    for (const effort of [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      for (const file of [
        configPath,
        join(root, ".factory-tickets.json"),
        join(root, ".amp/plugins/software-factory.js"),
      ])
        await rm(file, { force: true });
      expect(run(["--worker-effort", effort]).status).toBe(0);
      const config = await Bun.file(configPath).json();
      expect(config.workerEffort).toBe(effort);
    }
    const config = await Bun.file(configPath).json();
    for (const invalid of ["turbo", "", null, 1, false, [], {}]) {
      await writeFile(
        configPath,
        JSON.stringify({ ...config, workerEffort: invalid }),
      );
      expect(run(["--check"]).status).toBe(1);
      const factory = createFactory(root, host, () => {
        throw new Error("Must reject before store");
      });
      expect(factory.tick("start", "T-owner")).rejects.toThrow(/workerEffort/);
      expect(factory.tick("reload", "T-owner")).rejects.toThrow(/workerEffort/);
    }
    for (const review of [null, "true", 1, [], {}]) {
      await writeFile(configPath, JSON.stringify({ ...config, review }));
      expect(configuration(root)).rejects.toThrow(/review/);
    }
    await writeFile(
      configPath,
      JSON.stringify({ ...config, review: true, workerModel: "unknown/model" }),
    );
    expect(configuration(root)).rejects.toThrow(/OpenAI or Anthropic/);
    for (const setup of ["", " ", null, 1, false, [], {}]) {
      await writeFile(configPath, JSON.stringify({ ...config, setup }));
      expect(configuration(root)).rejects.toThrow(/nonempty text/);
    }
    for (const setupTimeoutMs of [null, 0, -1, 1.5, "1000", 2_147_483_648]) {
      await writeFile(
        configPath,
        JSON.stringify({ ...config, setup: "true", setupTimeoutMs }),
      );
      expect(configuration(root)).rejects.toThrow(/setupTimeoutMs/);
    }
    await writeFile(
      configPath,
      JSON.stringify({ ...config, setupTimeoutMs: 1000 }),
    );
    expect(configuration(root)).rejects.toThrow(/setupTimeoutMs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("installer writes a light lane with capacity 2 and refuses an unknown light model before writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-light-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(join(root, "prd.md"), "# Fixture\n");
    const store = join(root, "store.ts");
    await writeFile(store, "export function openStore() {}\n");
    const run = (flags: string[]) =>
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
          store,
          ...flags,
        ],
        { encoding: "utf8" },
      );
    const configPath = join(root, ".factory.json");
    expect(run(["--light-worker-model", "unknown/model"]).status).toBe(1);
    expect(await Bun.file(configPath).exists()).toBe(false);
    expect(
      run([
        "--light-worker-model",
        "anthropic/claude-sonnet-5-5",
        "--light-worker-effort",
        "xhigh",
      ]).status,
    ).toBe(0);
    expect(await Bun.file(configPath).json()).toMatchObject({
      capacity: 2,
      lightWorker: { model: "anthropic/claude-sonnet-5-5", effort: "xhigh" },
    });
    expect(await configuration(root)).toMatchObject({
      lightWorker: { model: "anthropic/claude-sonnet-5-5", effort: "xhigh" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("refresh rebuilds only the adapter in two repositories", async () => {
  const home = await mkdtemp(join(tmpdir(), "factory-refresh-"));
  try {
    const store = join(home, "store.ts");
    await writeFile(store, "export function openStore() {}\n");
    for (const name of ["first", "second"]) {
      const root = join(home, name);
      await mkdir(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      const args = [
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
        store,
      ];
      const run = (flags: string[] = []) =>
        spawnSync("bun", [...args, ...flags], { encoding: "utf8" });
      for (const flags of [
        ["--setup", " "],
        ["--setup-timeout-ms", "1000"],
        ["--setup", "true", "--setup-timeout-ms", "0"],
      ]) {
        expect(run(flags).status).toBe(1);
        expect(await Bun.file(join(root, ".factory.json")).exists()).toBe(
          false,
        );
      }
      expect(
        run(
          name === "first"
            ? [
                "--review",
                "--setup",
                "bun install --frozen-lockfile",
                "--setup-timeout-ms",
                "90000",
              ]
            : [],
        ).status,
      ).toBe(0);
      const plugin = join(root, ".amp/plugins/software-factory.js");
      const config = join(root, ".factory.json");
      const saved = await Bun.file(config).json();
      expect(saved.review).toBe(name === "first");
      expect(saved.setup).toBe(
        name === "first" ? "bun install --frozen-lockfile" : undefined,
      );
      expect(saved.setupTimeoutMs).toBe(name === "first" ? 90000 : undefined);
      if (name === "second") delete saved.review;
      saved.workerModel = "anthropic/claude-sonnet-4.6";
      if (name === "first") saved.workerEffort = "high";
      else delete saved.workerEffort;
      saved.permissions.execute = true;
      await writeFile(config, JSON.stringify(saved));
      const configBefore = await Bun.file(config).text();
      const tickets = join(root, ".factory-tickets.json");
      await writeFile(tickets, '[{"id":"kept","brief":"Keep","after":[]}]\n');
      const ticketsBefore = await Bun.file(tickets).text();
      const runtime = join(root, ".git/factory/state.json");
      await mkdir(join(root, ".git/factory"), { recursive: true });
      await writeFile(runtime, '{"accepted":true}\n');

      expect(run().stdout).toContain("SETUP UNCHANGED");
      expect(run(["--check"]).status).toBe(0);
      await writeFile(plugin, "obsolete\n");
      expect(run(["--refresh"]).status).toBe(0);
      expect(await Bun.file(plugin).text()).toContain(
        "Sequential local factory dispatch",
      );
      expect(await Bun.file(config).text()).toBe(configBefore);
      expect(await Bun.file(tickets).text()).toBe(ticketsBefore);
      expect(await Bun.file(runtime).text()).toBe('{"accepted":true}\n');

      await rm(plugin);
      expect(run(["--check"]).status).toBe(1);
      expect(await Bun.file(plugin).exists()).toBe(false);
      expect(run(["--refresh"]).status).toBe(0);
      expect(await Bun.file(plugin).text()).toContain(
        "Sequential local factory dispatch",
      );

      await writeFile(plugin, "preserved on bundle failure\n");
      const invalidStore = join(home, "invalid.ts");
      await writeFile(invalidStore, "export function openStore( {\n");
      expect(run(["--refresh", "--store", invalidStore]).status).toBe(1);
      expect(await Bun.file(plugin).text()).toBe(
        "preserved on bundle failure\n",
      );
      expect(run(["--refresh", "--check"]).status).toBe(1);
    }
    const uninitialized = join(home, "uninitialized");
    await mkdir(uninitialized);
    execFileSync("git", ["init", "-q", uninitialized]);
    expect(
      spawnSync("bun", [installer, "--repo", uninitialized, "--refresh"], {
        encoding: "utf8",
      }).status,
    ).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

async function tree(root: string) {
  const files: Record<string, string> = {};
  for (const path of await readdir(root, { recursive: true }))
    if ((await stat(join(root, path))).isFile())
      files[path] = await readFile(join(root, path), "utf8");
  return files;
}

// Runs the declared command in a copy of the installed repository, as a new orb would.
async function runMoved(root: string, moved: string, command: string) {
  await cp(root, moved, { recursive: true });
  const child = Bun.spawn(command.split(" "), {
    cwd: moved,
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const { value } = await child.stdout.getReader().read();
    const port = /port (\d+)/.exec(new TextDecoder().decode(value))?.[1];
    expect(port).toBeDefined();
    const url = `http://127.0.0.1:${port}`;
    expect(await (await fetch(`${url}/`)).text()).toBe(
      await readFile(join(import.meta.dir, "dashboard.html"), "utf8"),
    );
    expect((await fetch(`${url}/api/status`)).status).toBe(200);
    expect((await fetch(`${url}/api/status`, { method: "POST" })).status).toBe(
      405,
    );
  } finally {
    child.kill();
    await child.exited;
  }
}

test("setup and refresh declare the dashboard service in two repositories without rewriting their own services", async () => {
  const home = await mkdtemp(join(tmpdir(), "factory-services-"));
  try {
    const store = join(home, "store.ts");
    await writeFile(store, "export function openStore() {}\n");
    const own =
      '# Our services\nservices:\n  api:   # keep this\n    command: "bun api.ts"\n    port: 3000\n';
    const conflict =
      "services:\n  factory-dashboard:\n    command: bun mine.ts\n";
    const fourSpaces = "services:\n    api:\n        command: bun api.ts\n";
    const setup = (name: string) => {
      const root = join(home, name);
      execFileSync("git", ["init", "-q", root]);
      const run = (...flags: string[]) =>
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
            store,
            ...flags,
          ],
          { encoding: "utf8" },
        );
      return { root, run };
    };
    const services = (root: string) => join(root, ".amp/services.yaml");
    const want = {
      command: "bun .amp/factory/dashboard.js --repo .",
      port: 4310,
      health: "/api/status",
      portal: {
        title: "Factory dashboard",
        description: "Read-only factory status served on the API origin.",
      },
    };

    const refused = [
      ["conflict", conflict],
      ["four-spaces", fourSpaces],
    ] as const;
    for (const [name, content] of refused) {
      const { root, run } = setup(name);
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      await mkdir(join(root, ".amp"));
      await writeFile(services(root), content);
      const before = await tree(root);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("services.yaml");
      expect(await tree(root)).toEqual(before);
    }

    for (const [name, own_] of [
      ["first", own],
      ["second", undefined],
    ] as const) {
      const { root, run } = setup(name);
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      if (own_ !== undefined) {
        await mkdir(join(root, ".amp"));
        await writeFile(services(root), own_);
      }
      expect(run().status).toBe(0);
      const installed = await readFile(services(root), "utf8");
      expect(installed.startsWith(own_ ?? "services:\n")).toBe(true);
      const parsed = Bun.YAML.parse(installed) as {
        services: Record<string, unknown>;
      };
      expect(Object.keys(parsed.services)).toEqual(
        own_ ? ["api", "factory-dashboard"] : ["factory-dashboard"],
      );
      expect(parsed.services["factory-dashboard"]).toEqual(want);
      const config = await Bun.file(join(root, ".factory.json")).json();
      expect(config.permissions).toEqual({
        execute: false,
        publish: false,
        externalTickets: false,
      });

      const settled = await tree(root);
      expect(run().stdout).toContain("SETUP UNCHANGED");
      expect(run("--check").status).toBe(0);
      expect(run("--refresh").status).toBe(0);
      expect(await tree(root)).toEqual(settled);
      expect(
        execFileSync("git", ["-C", root, "status", "--porcelain"], {
          encoding: "utf8",
        }),
      ).not.toContain(".amp/factory");

      const bundle = await readFile(
        join(root, ".amp/factory/dashboard.js"),
        "utf8",
      );
      expect(bundle).not.toContain(resolve(import.meta.dir));
      await runMoved(root, join(home, `${name}-moved`), want.command);

      await writeFile(services(root), own_ ?? "");
      const old = await tree(root);
      expect(run("--check").status).toBe(1);
      expect(await tree(root)).toEqual(old);
      expect(run("--refresh").status).toBe(0);
      expect(await readFile(services(root), "utf8")).toBe(installed);
      expect(await tree(root)).toEqual(settled);

      await writeFile(join(root, ".amp/plugins/software-factory.js"), "old\n");
      await writeFile(services(root), conflict);
      const stale = await tree(root);
      expect(run("--refresh").status).toBe(1);
      expect(await tree(root)).toEqual(stale);
      await writeFile(services(root), installed);
      expect(run("--refresh").status).toBe(0);

      await mkdir(join(root, "web/dist"), { recursive: true });
      await writeFile(join(root, "web/dist/index.html"), "<p>built page</p>");
      const before = await tree(root);
      const server = startDashboard({ root, port: 0 });
      try {
        const url = `http://127.0.0.1:${server.port}`;
        expect(await (await fetch(`${url}/`)).text()).toBe("<p>built page</p>");
        expect((await fetch(`${url}/api/status`)).status).toBe(200);
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
          for (const path of [
            "/",
            "/api/status",
            "/api/events",
            "/api/definition",
          ])
            expect(
              (await fetch(`${url}${path}`, { method, body: "{}" })).status,
            ).toBe(405);
      } finally {
        await server.stop(true);
      }
      expect(await tree(root)).toEqual(before);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

test("refresh excludes the generated plugin and dashboard in an upgraded install and a fresh clone", async () => {
  const home = await mkdtemp(join(tmpdir(), "factory-exclude-"));
  try {
    const store = join(home, "store.ts");
    await writeFile(store, "export function openStore() {}\n");
    const git = (root: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8" },
      );
    const refresh = (root: string, ...flags: string[]) =>
      spawnSync(
        "bun",
        [installer, "--repo", root, "--refresh", "--store", store, ...flags],
        { encoding: "utf8" },
      );
    const source = join(home, "source");
    execFileSync("git", ["init", "-q", source]);
    await writeFile(join(source, "prd.md"), "# Fixture\n");
    const created = spawnSync(
      "bun",
      [
        installer,
        "--repo",
        source,
        "--prd",
        "prd.md",
        "--verify",
        "true",
      ].concat(["--scope", "src/", "--store", store]),
      { encoding: "utf8" },
    );
    expect(created.status).toBe(0);
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "fixture");
    expect(git(source, "status", "--porcelain")).toBe("");

    // The base installer excluded only the plugin and never wrote .amp/factory.
    const upgraded = join(home, "upgraded");
    await cp(source, upgraded, { recursive: true });
    await rm(join(upgraded, ".amp/factory"), { recursive: true });
    const exclude = join(upgraded, ".git/info/exclude");
    await writeFile(exclude, "/.amp/plugins/software-factory.js\n");
    expect(git(upgraded, "status", "--porcelain")).toBe("");

    const cloned = join(home, "cloned");
    execFileSync("git", ["clone", "-q", source, cloned]);
    expect(
      await Bun.file(join(cloned, ".amp/plugins/software-factory.js")).exists(),
    ).toBe(false);

    for (const root of [upgraded, cloned]) {
      const excludePath = join(root, ".git/info/exclude");
      const before = await readFile(excludePath, "utf8");
      expect(refresh(root, "--check").status).toBe(1);
      expect(await readFile(excludePath, "utf8")).toBe(before);
      expect(refresh(root).status).toBe(0);
      expect(git(root, "status", "--porcelain")).toBe("");
      const settled = await readFile(excludePath, "utf8");
      expect(refresh(root).status).toBe(0);
      expect(await readFile(excludePath, "utf8")).toBe(settled);
      const lines = settled.split("\n");
      for (const rule of [
        "/.amp/plugins/software-factory.js",
        "/.amp/factory/",
      ])
        expect(lines.filter((line) => line === rule)).toHaveLength(1);
      expect(
        await Bun.file(join(root, ".amp/factory/dashboard.js")).exists(),
      ).toBe(true);
    }
    expect(
      (await readFile(exclude, "utf8")).startsWith(
        "/.amp/plugins/software-factory.js\n",
      ),
    ).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);
