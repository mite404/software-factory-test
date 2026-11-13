import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuration, createFactory, type NativeHost } from "./native";

const installer = resolve(import.meta.dir, "setup-factory.ts");

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
  const skill = execFileSync("amp", ["skill", "info", "poteto-mode"], { encoding: "utf8" });
  const uri = skill.match(/^Path: (file:\/\/\S+)$/m)?.[1];
  if (!uri) throw new Error("Missing poteto fixture prerequisite");
  const { openStore } = await import(`${decodeURI(uri)}/scripts/orch/store.ts`);
  for (const failure of ["create", "send"]) {
    const root = await mkdtemp(join(tmpdir(), "factory-unknown-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "prd.md"), "# Fixture\n");
      expect(spawnSync("bun", [installer, "--repo", root, "--prd", "prd.md", "--verify", "true", "--scope", "src/"], { encoding: "utf8" }).status).toBe(0);
      const config = await Bun.file(join(root, ".factory.json")).json();
      config.permissions.execute = true;
      await writeFile(join(root, ".factory.json"), JSON.stringify(config));
      await writeFile(join(root, ".factory-tickets.json"), JSON.stringify([
        { id: "X", brief: "First", after: [] }, { id: "Y", brief: "Independent", after: [] },
      ]));
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
      let creates = 0;
      let sends = 0;
      const host: NativeHost = {
        async create() { creates++; if (failure === "create") throw new Error("lost creation response"); return "T-unknown"; },
        async send() { sends++; throw new Error("lost delivery response"); },
        async state() { return "running"; }, watch() {},
      };
      await expect(createFactory(root, host, openStore).tick("start", "T-owner")).rejects.toThrow(/lost/);
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

test.each(["high", undefined])("native dispatch preserves effort %s, same-worker correction, and recovery", async (effort) => {
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
    expect(await readFile(join(root, ".factory.json"), "utf8")).toBe(savedConfig);
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
    const skill = execFileSync("amp", ["skill", "info", "poteto-mode"], {
      encoding: "utf8",
    });
    const uri = skill.match(/^Path: (file:\/\/\S+)$/m)?.[1];
    if (!uri) throw new Error("Missing poteto fixture prerequisite");
    const { openStore } = await import(
      `${decodeURI(uri)}/scripts/orch/store.ts`
    );
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
      (await readFile(join(factory.directory, "state.sqlite"))).subarray(0, 16).toString(),
    ).toBe("SQLite format 3\u0000");
    expect(created).toBe(1);
    expect(settings).toEqual([["T-owner", "openai/gpt-6.1-sol", effort]]);
    const worktree = join(root, ".git/factory/worktrees/A");
    expect(await Bun.file(join(worktree, "src/value")).exists()).toBe(true);
    const candidate = async (value: string, attempt: number, insight = "") => {
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
    await writeFile(join(root, ".factory.json"), JSON.stringify({ ...config, workerEffort: "max" }));
    await factory.tick("reconcile");
    expect(created).toBe(1);
    expect(messages.map((message) => message.id)).toEqual([
      "T-fixture-1",
      "T-fixture-1",
    ]);
    await writeFile(join(root, ".factory.json"), savedConfig);
    expect(await readFile(join(root, "src/value"), "utf8")).toBe("old");
    await candidate("good", 2, "Use the shared value contract");
    factory = createFactory(root, host, openStore);
    const state = await factory.tick("reconcile");
    expect(state.runs.A?.kind).toBe("done");
    expect(await readFile(join(root, "src/value"), "utf8")).toBe("good");
    expect(created).toBe(2);
    expect(messages[2]?.text).toContain("Use the shared value contract");
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
    expect(messages[3]?.text).not.toContain("Use the shared value contract");
    await Promise.all(
      Array.from({ length: 8 }, () => factory.tick("reconcile")),
    );
    expect(created).toBe(3);
    const db = new Database(join(factory.directory, "state.sqlite"), { readonly: true });
    const events = db.query<{ ticket: string; action: string }, []>(
      "SELECT ticket, action FROM events",
    ).all();
    expect(db.query("SELECT detail FROM events WHERE ticket = 'A' AND action = 'accepted'").all())
      .toEqual([{ detail: git("rev-parse", "HEAD") }]);
    db.close();
    expect(
      events.filter(
        (event) => event.ticket === "B" && event.action === "blocked",
      ),
    ).toHaveLength(1);
    await factory.tick("pause");
    factory = createFactory(root, host, openStore);
    expect((await factory.tick("reconcile")).enabled).toBe(false);
    expect(created).toBe(3);
    expect(settings).toEqual(Array.from({ length: 3 }, () => ["T-owner", "openai/gpt-6.1-sol", effort]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
