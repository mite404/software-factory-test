import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuration, createFactory, type NativeHost } from "./native";

const installer = resolve(import.meta.dir, "setup-factory.ts");

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
