import { expect, test } from "bun:test";
import type { PluginAPI, PluginToolContext } from "@ampcode/plugin";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "./backup";
import registerFactory from "./plugin";
import { factoryStatus, openPersistence, type State } from "./persistence";

test("backup CLI rejects destination overrides without publishing", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "backup.ts"),
      "--destination",
      "other/repo",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("Usage:");
});

test("private backups publish consistent isolated projects and reconcile uncertain transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-backup-"));
  const originalEnvironment = { ...process.env };
  const identityVariables = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "EMAIL",
  ];
  const gitExecutable = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(gitExecutable, ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const metadataPath = join(root, "metadata");
  const modePath = join(root, "mode");
  const pushes = join(root, "pushes");
  const rewritePath = join(root, "rewrite");
  const credentialRewrite = "url.git@github.com:.insteadOf=https://github.com/";
  const metadata = {
    nameWithOwner: "owner/memory",
    url: "https://github.com/owner/memory",
    isPrivate: true,
    visibility: "PRIVATE",
    defaultBranchRef: { name: "main" },
  };
  const config = {
    version: 1,
    capacity: 1,
    workerModel: "openai/sol",
    prd: "prd.md",
    tickets: "tickets.json",
    scope: ["src/"],
    verify: "true",
    backup: { repository: "owner/memory", projectKey: "alpha" },
    permissions: {
      execute: false,
      publish: false,
      externalTickets: false,
      backup: true as boolean | undefined,
    },
  };
  const project = join(root, "app");
  const directory = join(project, ".git/factory");
  const receipt = () => Bun.file(join(directory, "backup/receipt.json")).json();
  const configure = () =>
    writeFile(join(project, ".factory.json"), JSON.stringify(config));
  let dispose = () => {};
  let writer: ReturnType<typeof setInterval> | undefined;
  try {
    await mkdir(bin);
    identityVariables.forEach((key) => {
      delete process.env[key];
    });
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
    const signer = join(bin, "signer");
    await writeFile(
      signer,
      `#!${process.execPath}
const commit=await Bun.stdin.text();
const mode=Bun.file(${JSON.stringify(modePath)});
if(!/^author Fixture <fixture@example.invalid> /m.test(commit) || !/^committer Fixture <fixture@example.invalid> /m.test(commit) || (await mode.exists() && await mode.text()==="commit-failed")) {
  console.error("No signing key is available for this commit. Amp signs only commits made as the Git identity your current settings give this orb.");
  process.exit(1);
}
console.log("-----BEGIN PGP SIGNATURE-----\\nfixture\\n-----END PGP SIGNATURE-----");
console.error("[GNUPG:] SIG_CREATED D 1 10 00 0 FIXTURE");
`,
    );
    await chmod(signer, 0o755);
    await writeFile(
      process.env.GIT_CONFIG_GLOBAL,
      `[user]\nname = Fixture\nemail = fixture@example.invalid\nuseConfigOnly = true\n[commit]\ngpgsign = true\n[gpg]\nprogram = ${signer}\nformat = openpgp\n`,
    );
    await mkdir(project);
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.name", "Fixture");
    git(project, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(project, "prd.md"), "fixture");
    await writeFile(join(project, "tickets.json"), "[]");
    await configure();
    git(project, "add", ".");
    git(project, "commit", "-qm", "fixture");
    git(root, "clone", "--bare", project, remote);
    await writeFile(metadataPath, JSON.stringify(metadata));
    await writeFile(modePath, "");
    await writeFile(pushes, "");
    await writeFile(
      join(bin, "gh"),
      `#!${process.execPath}
if(process.argv.slice(2)[2]!=="github.com/owner/memory") process.exit(1);
if(await Bun.file(${JSON.stringify(modePath)}).text()==="inaccessible") { console.error("credential-secret"); process.exit(1); }
console.log(await Bun.file(${JSON.stringify(metadataPath)}).text());
`,
    );
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}
import {appendFileSync, existsSync, writeFileSync} from "node:fs";
const args=process.argv.slice(2);
const mode=await Bun.file(${JSON.stringify(modePath)}).text();
if(args[0]==="fetch" && ["unavailable","unpublished"].includes(mode) && existsSync(${JSON.stringify(pushes)}+".sent")) process.exit(1);
if(args[0]==="push") {
  appendFileSync(${JSON.stringify(pushes)}, "push\\n");
  if(mode==="unpublished") { writeFileSync(${JSON.stringify(pushes)}+".sent", ""); process.exit(1); }
  if(mode==="rejected") { console.error("credential-secret"); process.exit(1); }
}
const network=["clone","push","fetch"].includes(args[0]);
const rewrite=existsSync(${JSON.stringify(rewritePath)})?["-c",${JSON.stringify(credentialRewrite)}]:[];
const p=Bun.spawn([${JSON.stringify(gitExecutable)}, ...rewrite, ...(network?["-c",${JSON.stringify(`url.${remote}.insteadOf=https://github.com/owner/memory.git`)}]:[]),...args], {stdout:"inherit",stderr:"inherit"});
const code=await p.exited;
if(args[0]==="push" && code===0) {
  writeFileSync(${JSON.stringify(pushes)}+".sent", "");
  if(mode==="lost" || mode==="unavailable") process.exit(1);
}
process.exit(code);
`,
    );
    await chmod(join(bin, "git"), 0o755);
    await chmod(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${originalEnvironment.PATH}`;
    config.permissions.backup = undefined;
    await configure();
    expect(backup(project)).rejects.toThrow("permissions.backup");
    expect(await readFile(pushes, "utf8")).toBe("");
    config.permissions.backup = false;
    config.permissions.execute = true;
    await configure();
    expect(backup(project)).rejects.toThrow("permissions.backup");
    expect(await readFile(pushes, "utf8")).toBe("");
    config.permissions.execute = false;
    config.permissions.backup = true;
    await writeFile(
      join(project, ".factory.json"),
      JSON.stringify({ ...config, backup: undefined }),
    );
    expect(backup(project)).rejects.toThrow("Configure backup");
    for (const invalid of [
      "owner/../repo",
      "https://credential-secret@github.com/owner/repo",
      "-owner/repo",
    ]) {
      config.backup.repository = invalid;
      await configure();
      expect(backup(project)).rejects.toThrow("Invalid backup");
    }
    config.backup.repository = "owner/memory";
    for (const invalid of ["../escape", "a/b", ".", "-flag"]) {
      config.backup.projectKey = invalid;
      await configure();
      expect(backup(project)).rejects.toThrow("Invalid backup");
    }
    config.backup.projectKey = "alpha";
    await configure();
    for (const invalid of [
      { ...metadata, visibility: "INTERNAL" },
      { ...metadata, visibility: "PUBLIC" },
      { ...metadata, visibility: undefined },
      { ...metadata, visibility: true },
      { ...metadata, nameWithOwner: "other/memory" },
      { ...metadata, url: "https://enterprise.invalid/owner/memory" },
      {},
    ]) {
      await writeFile(metadataPath, JSON.stringify(invalid));
      expect(backup(project)).rejects.toThrow(
        "Backup destination must be an accessible private repository with a default branch",
      );
    }
    await writeFile(metadataPath, "null");
    expect(backup(project)).rejects.toThrow("Backup failed");
    await writeFile(
      metadataPath,
      JSON.stringify({
        ...metadata,
        defaultBranchRef: { name: "../escape" },
      }),
    );
    expect(backup(project)).rejects.toThrow("Backup failed");
    await writeFile(metadataPath, JSON.stringify(metadata));
    await writeFile(modePath, "inaccessible");
    expect(backup(project)).rejects.toThrow("Backup failed");
    const deniedCLI = Bun.spawn(
      [process.execPath, join(import.meta.dir, "backup.ts"), project],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    expect(await deniedCLI.exited).toBe(1);
    expect(await new Response(deniedCLI.stdout).text()).toBe("");
    expect(await new Response(deniedCLI.stderr).text()).toBe(
      "Backup failed; inspect local configuration, database, and repository access\n",
    );
    await writeFile(modePath, "");
    expect(backup(project)).rejects.toThrow("Factory database does not exist");
    await writeFile(join(directory, "state.sqlite"), "corrupt");
    expect(backup(project)).rejects.toThrow("Backup failed");
    await rm(join(directory, "state.sqlite"));
    const storage = openPersistence(directory, []);
    storage.commit(
      { enabled: false, runs: {} },
      "factory",
      "fixture",
      "consistent",
    );
    storage.close();
    const first = await backup(project);
    expect(first.status).toBe("confirmed");
    const revision = git(remote, "rev-parse", "main");
    expect(first.lastConfirmed?.revision).toBe(revision);
    expect(
      git(remote, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", revision),
    ).toBe(
      "Fixture <fixture@example.invalid>\nFixture <fixture@example.invalid>",
    );
    await writeFile(rewritePath, "");
    expect(
      git(
        join(directory, "backup/repository"),
        "-c",
        credentialRewrite,
        "remote",
        "get-url",
        "origin",
      ),
    ).toBe("git@github.com:owner/memory.git");
    expect(
      git(
        remote,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        revision,
      ).split("\n"),
    ).toEqual(["projects/alpha/manifest.json", "projects/alpha/state.sqlite"]);
    expect(
      JSON.parse(git(remote, "show", "main:projects/alpha/manifest.json")),
    ).toEqual({
      projectKey: "alpha",
      schemaVersion: 2,
      applicationRevision: git(project, "rev-parse", "HEAD"),
    });
    expect((await backup(project)).lastConfirmed?.revision).toBe(revision);
    expect(await readFile(pushes, "utf8")).toBe("push\n");
    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "backup.ts"), project],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    expect(await new Response(cli.stderr).text()).toBe("");
    expect(await cli.exited).toBe(0);
    expect(
      JSON.parse(await new Response(cli.stdout).text()).lastConfirmed.revision,
    ).toBe(revision);
    let execute!: (
      input: { action: string },
      ctx: PluginToolContext,
    ) => Promise<unknown>;
    registerFactory(
      {
        on() {},
        registerTool(tool: { execute: typeof execute }) {
          execute = tool.execute;
        },
        onDispose(fn: () => void) {
          dispose = fn;
        },
        logger: { log() {} },
      } as unknown as PluginAPI,
      project,
      () => ({
        async init() {},
        async close() {},
        ledger: { async record() {} },
      }),
    );
    config.permissions.backup = false;
    await configure();
    const operatorContext = {
      thread: { id: "T-operator" },
    } as unknown as PluginToolContext;
    expect(execute({ action: "backup" }, operatorContext)).rejects.toThrow(
      "permissions.backup",
    );
    config.permissions.backup = true;
    await configure();
    const ownership = openPersistence(directory, []);
    ownership.commit(
      {
        enabled: false,
        runs: {
          protected: {
            kind: "done",
            revision,
            thread: "T-worker",
            insight: "Retained worker and reviewer ownership",
            review: {
              ticket: "protected",
              attempt: 1,
              revision,
              base: "a".repeat(40),
              stage: "post-graft",
              worktree: "/private/review",
              model: "anthropic/reviewer",
              report: "/private/report.json",
              log: "/private/gates.log",
              command: "bun test",
              delivery: "sent",
              thread: "T-reviewer",
            },
          },
        },
      },
      "factory",
      "ownership",
      "Persist worker and reviewer control exclusions",
    );
    ownership.close();
    const priorReceipt = await receipt();
    const priorPushes = await readFile(pushes, "utf8");
    await Promise.all(
      ["T-worker", "T-reviewer"].map(async (id) => {
        expect(
          execute({ action: "backup" }, {
            thread: { id },
          } as PluginToolContext),
        ).rejects.toThrow("Workers cannot control the factory");
        expect(await receipt()).toEqual(priorReceipt);
        expect(await readFile(pushes, "utf8")).toBe(priorPushes);
      }),
    );
    expect(
      JSON.parse(String(await execute({ action: "backup" }, operatorContext)))
        .status,
    ).toBe("confirmed");
    const authorizedRevision = git(remote, "rev-parse", "main");
    expect(authorizedRevision).not.toBe(revision);
    expect(await readFile(pushes, "utf8")).toBe(`${priorPushes}push\n`);
    dispose();
    const pluginPath = join(project, ".amp/plugins/software-factory.js");
    await mkdir(join(project, ".amp/plugins"), { recursive: true });
    await writeFile(pluginPath, "");
    const install = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "setup-factory.ts"),
        "--repo",
        project,
        "--refresh",
        "--store",
        join(import.meta.dir, "bookkeeping.fixture.ts"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await install.exited).toBe(0);
    const hostedStorage = openPersistence(directory, []);
    hostedStorage.event(
      "factory",
      "compiled-host",
      "real installed tool publication",
    );
    hostedStorage.close();
    const hostPath = join(root, "compiled-host.ts");
    await writeFile(
      hostPath,
      `
if (!process.env.BUN_BE_BUN) throw Error("Expected compiled-host launch");
delete process.env.BUN_BE_BUN;
const spawn = Bun.spawn.bind(Bun);
Bun.spawn = (args, options) => spawn(args, {...options, env: options?.env ?? process.env});
const {default: register} = await import(${JSON.stringify(pluginPath)});
let execute, dispose;
register({on() {}, registerTool(tool) {execute=tool.execute;}, onDispose(fn) {dispose=fn;}, logger:{log(){}}});
let heartbeats=0;
const timer=setInterval(()=>heartbeats++,5);
try {
  const receipt=JSON.parse(await execute({action:"backup"},{thread:{id:"T-operator"}}));
  console.log(JSON.stringify({receipt,heartbeats,execPath:process.execPath,childFlag:process.env.BUN_BE_BUN ?? null}));
} finally {clearInterval(timer);dispose();}
`,
    );
    const compiledHost = Bun.spawn(["amp", "run", hostPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_BE_BUN: "1" },
    });
    const hostError = await new Response(compiledHost.stderr).text();
    expect(hostError).toBe("");
    expect(await compiledHost.exited).toBe(0);
    const hosted = JSON.parse(await new Response(compiledHost.stdout).text());
    expect(hosted.execPath).not.toBe(process.execPath);
    expect(hosted.childFlag).toBeNull();
    expect(hosted.receipt.status).toBe("confirmed");
    expect(hosted.receipt.lastConfirmed.revision).toBe(
      git(remote, "rev-parse", "main"),
    );
    expect(
      git(remote, "rev-list", "--count", `${authorizedRevision}..main`),
    ).toBe("1");
    expect(hosted.heartbeats).toBeGreaterThan(0);
    config.backup.projectKey = "beta";
    await configure();
    const second = await backup(project);
    expect(second.status).toBe("confirmed");
    expect(
      git(remote, "ls-tree", "-r", "--name-only", "main")
        .split("\n")
        .filter((p) => p.startsWith("projects/")),
    ).toEqual([
      "projects/alpha/manifest.json",
      "projects/alpha/state.sqlite",
      "projects/beta/manifest.json",
      "projects/beta/state.sqlite",
    ]);
    expect(git(remote, "show", "main:prd.md")).toBe("fixture");
    git(project, "commit", "--allow-empty", "-qm", "application advance");
    const advanced = await backup(project);
    expect(advanced.status).toBe("confirmed");
    expect(advanced.lastConfirmed?.revision).not.toBe(
      second.lastConfirmed?.revision,
    );
    expect(
      JSON.parse(git(remote, "show", "main:projects/beta/manifest.json"))
        .applicationRevision,
    ).toBe(git(project, "rev-parse", "HEAD"));
    expect((await backup(project)).lastConfirmed).toEqual(
      advanced.lastConfirmed,
    );
    const change = () => {
      const db = openPersistence(directory, []);
      db.event("factory", "changed", "new input");
      db.close();
    };
    for (const projectKey of ["beta", "gamma"]) {
      config.backup.projectKey = projectKey;
      await configure();
      change();
      const before = git(remote, "rev-parse", "main");
      const lastConfirmed = (await receipt()).lastConfirmed;
      await writeFile(modePath, "commit-failed");
      expect(backup(project)).rejects.toThrow(
        "Backup commit was refused; inspect commit identity and signing configuration",
      );
      expect(await receipt()).toEqual({ status: "failed", lastConfirmed });
      expect(git(remote, "rev-parse", "main")).toBe(before);
      expect(
        git(join(directory, "backup/repository"), "status", "--porcelain"),
      ).toContain(`projects/${projectKey}/state.sqlite`);
      await writeFile(modePath, "");
      const workspace = join(directory, "backup/repository");
      await writeFile(
        join(workspace, "conflict"),
        "preserve foreign staged work",
      );
      git(workspace, "add", "conflict");
      expect(backup(project)).rejects.toThrow(
        "Backup workspace has conflicting changes",
      );
      expect(await readFile(join(workspace, "conflict"), "utf8")).toBe(
        "preserve foreign staged work",
      );
      expect(git(workspace, "diff", "--cached", "--name-only")).toContain(
        "conflict",
      );
      git(workspace, "reset", "--quiet", "HEAD", "--", "conflict");
      await rm(join(workspace, "conflict"));
      const retried = await backup(project);
      expect(retried.status).toBe("confirmed");
      expect(git(remote, "rev-list", "--count", `${before}..main`)).toBe("1");
      expect((await backup(project)).lastConfirmed).toEqual(
        retried.lastConfirmed,
      );
    }
    config.backup.projectKey = "beta";
    await configure();
    change();
    await writeFile(modePath, "lost");
    const lost = await backup(project);
    expect(lost.status).toBe("confirmed");
    const count = (await readFile(pushes, "utf8")).split("\n").length;
    expect((await backup(project)).lastConfirmed).toEqual(lost.lastConfirmed);
    expect((await readFile(pushes, "utf8")).split("\n").length).toBe(count);
    change();
    await rm(`${pushes}.sent`);
    await writeFile(modePath, "unavailable");
    const uncertain = await backup(project);
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.lastConfirmed).toEqual(lost.lastConfirmed);
    expect((await backup(project)).status).toBe("uncertain");
    await writeFile(modePath, "inaccessible");
    expect(backup(project)).rejects.toThrow("Backup failed");
    expect((await receipt()).status).toBe("uncertain");
    expect((await receipt()).publication).toEqual(uncertain.publication);
    await writeFile(modePath, "");
    await rm(join(directory, "backup/repository"), { recursive: true });
    const recovered = await backup(project);
    expect(recovered.status).toBe("confirmed");
    expect((await readFile(pushes, "utf8")).split("\n").length).toBe(count + 1);
    change();
    await writeFile(modePath, "rejected");
    expect((await backup(project)).status).toBe("failed");
    expect((await receipt()).lastConfirmed).toEqual(recovered.lastConfirmed);
    await writeFile(modePath, "");
    expect((await backup(project)).status).toBe("confirmed");
    const live = new Database(join(directory, "state.sqlite"));
    live.run("PRAGMA journal_mode=WAL");
    live.close();
    const retainedState: State = {
      enabled: false,
      owner: "T-foreman",
      runs: {
        adoption: {
          kind: "blocked",
          reason: "two failed review attempts",
          thread: "T-original-worker",
          repair: {
            kind: "running",
            base: "a".repeat(40),
            worktree: "/private/worker",
            thread: "T-original-worker",
            attempt: 2,
            delivery: "sent",
          },
        },
        reviewing: {
          kind: "running",
          base: "a".repeat(40),
          worktree: "/private/reviewed-worker",
          thread: "T-reviewed-worker",
          attempt: 1,
          delivery: "sent",
          review: {
            ticket: "reviewing",
            attempt: 1,
            revision: "b".repeat(40),
            base: "a".repeat(40),
            stage: "post-graft",
            worktree: "/private/review",
            model: "anthropic/reviewer",
            report: "/private/report.json",
            log: "/private/gates.log",
            command: "bun test",
            delivery: "sent",
            thread: "T-reviewer",
          },
        },
        preparing: {
          kind: "preparing",
          base: "a".repeat(40),
          worktree: "/private/preparation",
          command: "bun install --frozen-lockfile",
          timeoutMs: 120000,
          log: "/private/setup.log",
        },
      },
    };
    let writes = 0;
    writer = setInterval(() => {
      const storage = openPersistence(directory, []);
      writes++;
      storage.commit(
        { ...retainedState, enabled: writes % 2 === 1 },
        "factory",
        "concurrent",
        String(writes),
      );
      storage.close();
    }, 5);
    const running = backup(project);
    const concurrent = backup(project);
    const results = await Promise.allSettled([running, concurrent]);
    clearInterval(writer);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const bytes = execFileSync(gitExecutable, [
      "-C",
      remote,
      "show",
      "main:projects/beta/state.sqlite",
    ]);
    const snapshotDirectory = join(root, "snapshot");
    await mkdir(snapshotDirectory);
    const snapshot = join(snapshotDirectory, "state.sqlite");
    await writeFile(snapshot, bytes);
    const db = new Database(snapshot, { readonly: true });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    const event = db
      .query(
        "SELECT detail FROM events WHERE action='concurrent' ORDER BY id DESC LIMIT 1",
      )
      .get() as { detail: string };
    expect(Number(event.detail)).toBeGreaterThan(0);
    expect(db.query("SELECT enabled FROM coordinator").get()).toEqual({
      enabled: Number(event.detail) % 2,
    });
    db.close();
    expect(factoryStatus(snapshotDirectory)).toEqual({
      ...retainedState,
      enabled: Number(event.detail) % 2 === 1,
    });
    const workspace = join(directory, "backup/repository");
    await writeFile(join(workspace, "conflict"), "do not discard");
    expect(backup(project)).rejects.toThrow(
      "Backup workspace has conflicting changes",
    );
    expect(await readFile(join(workspace, "conflict"), "utf8")).toBe(
      "do not discard",
    );
    await rm(join(workspace, "conflict"));
    change();
    await writeFile(modePath, "rejected");
    expect((await backup(project)).status).toBe("failed");
    const retained = git(workspace, "rev-parse", "HEAD");
    const other = join(root, "other");
    git(root, "clone", remote, other);
    await writeFile(join(other, "unrelated"), "preserve remote work");
    git(other, "add", "unrelated");
    git(
      other,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "remote advance",
    );
    git(other, "push", "origin", "main");
    const advancedRemote = git(remote, "rev-parse", "main");
    await writeFile(modePath, "");
    expect((await backup(project)).status).toBe("confirmed");
    expect(git(remote, "show", "main:unrelated")).toBe("preserve remote work");
    expect(git(remote, "rev-list", "--count", `${advancedRemote}..main`)).toBe(
      "1",
    );
    expect(git(workspace, "rev-parse", "HEAD")).not.toBe(retained);
    expect(
      git(remote, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", "main"),
    ).toBe(
      "Fixture <fixture@example.invalid>\nFixture <fixture@example.invalid>",
    );
    change();
    const beforeUnpublished = git(remote, "rev-parse", "main");
    await rm(`${pushes}.sent`);
    await writeFile(modePath, "unpublished");
    const unpublished = await backup(project);
    expect(unpublished.status).toBe("uncertain");
    expect(git(remote, "rev-parse", "main")).toBe(beforeUnpublished);
    await rm(workspace, { recursive: true });
    await writeFile(modePath, "");
    const recreated = await backup(project);
    expect(recreated.status).toBe("confirmed");
    expect(
      git(remote, "rev-list", "--count", `${beforeUnpublished}..main`),
    ).toBe("1");
    expect((await backup(project)).lastConfirmed).toEqual(
      recreated.lastConfirmed,
    );
    change();
    await writeFile(modePath, "rejected");
    expect((await backup(project)).status).toBe("failed");
    const conflictingLocal = git(workspace, "rev-parse", "HEAD");
    git(other, "pull", "--ff-only");
    const remoteDatabase = new Database(
      join(other, "projects/beta/state.sqlite"),
    );
    remoteDatabase.run(
      "INSERT INTO events(at,ticket,action,detail) VALUES ('now','factory','other-writer','preserve')",
    );
    remoteDatabase.close();
    const remoteBytes = await readFile(
      join(other, "projects/beta/state.sqlite"),
    );
    git(other, "add", "projects/beta/state.sqlite");
    git(
      other,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "same project advance",
    );
    git(other, "push", "origin", "main");
    const conflictingRemote = git(remote, "rev-parse", "main");
    await writeFile(modePath, "");
    expect(backup(project)).rejects.toThrow(
      "Backup branch has conflicting remote changes",
    );
    expect(git(remote, "rev-parse", "main")).toBe(conflictingRemote);
    expect(
      execFileSync(gitExecutable, [
        "-C",
        remote,
        "show",
        "main:projects/beta/state.sqlite",
      ]),
    ).toEqual(remoteBytes);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(conflictingLocal);
    expect(git(workspace, "status", "--porcelain")).toBe("");
    const pushesBeforeDestinationChange = await readFile(pushes, "utf8");
    git(
      workspace,
      "remote",
      "set-url",
      "origin",
      "https://github.com/other/memory.git",
    );
    expect(backup(project)).rejects.toThrow("Backup destination changed");
    expect(await readFile(pushes, "utf8")).toBe(pushesBeforeDestinationChange);
    expect(git(remote, "rev-parse", "main")).toBe(conflictingRemote);
    await rm(workspace, { recursive: true });
    const noIdentity = join(root, "no-identity.gitconfig");
    await writeFile(noIdentity, "[user]\nuseConfigOnly = true\n");
    process.env.GIT_CONFIG_GLOBAL = noIdentity;
    config.backup.projectKey = "fallback";
    await configure();
    expect((await backup(project)).status).toBe("confirmed");
    expect(
      git(remote, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", "main"),
    ).toBe(
      "Factory backup <factory@localhost>\nFactory backup <factory@localhost>",
    );
  } finally {
    clearInterval(writer);
    dispose();
    process.env = originalEnvironment;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
