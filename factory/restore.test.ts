import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactory } from "./native";
import {
  factoryStatus,
  openPersistence,
  sha256,
  type State,
} from "./persistence";

const owner = "T-prior-owner";
const evidence = "Passed the fixture boundary check\n";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

test("explicit replacement restore preserves evidence and fences retained owners before remote effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-restore-test-"));
  try {
    const source = join(root, "source");
    const replacement = join(root, "replacement");
    const remote = join(root, "memory.git");
    const bin = join(root, "bin");
    const storage = ".git/factory";
    const statePath = join(replacement, storage, "state.sqlite");
    const configuration = {
      version: 1,
      capacity: 1,
      workerModel: "openai/sol",
      prd: "prd.md",
      tickets: "tickets.json",
      scope: ["src/"],
      verify: "true",
      backup: { repository: "owner/memory", projectKey: "alpha" },
      permissions: {
        execute: true,
        publish: false,
        externalTickets: false,
        backup: true,
      },
    };
    await Promise.all([mkdir(source), mkdir(bin)]);
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh
[ "$DENY_RESTORE" != 1 ] || exit 1
printf '%s\\n' '{"nameWithOwner":"owner/memory","url":"https://github.com/owner/memory","visibility":"PRIVATE","defaultBranchRef":{"name":"main"}}'
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
case "$INTERRUPT_RESTORE:$1:$3" in
  1:cat-file:*/evidence.json) kill -KILL "$PPID"; exit 1 ;;
esac
exec ${JSON.stringify(Bun.which("git"))} "$@"
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/owner/memory.git",
      GIT_CONFIG_KEY_1: "commit.gpgSign",
      GIT_CONFIG_VALUE_1: "false",
    };
    const cli = async (file: string, args: string[], overrides = {}) => {
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, file), ...args],
        {
          env: { ...env, ...overrides },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, out, error] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, out, error };
    };
    const setup = (action: string, overrides?: object) =>
      cli("setup-factory.ts", ["--repo", replacement, action], overrides);
    git(source, "init", "-qb", "main");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    await writeFile(
      join(source, ".factory.json"),
      JSON.stringify(configuration),
    );
    await writeFile(join(source, "prd.md"), "fixture");
    await writeFile(join(source, "tickets.json"), "[]");
    git(source, "add", ".");
    git(source, "-c", "commit.gpgSign=false", "commit", "-qm", "application");
    const revision = git(source, "rev-parse", "HEAD");
    git(root, "clone", "--bare", source, remote);
    git(root, "clone", "--no-local", source, replacement);
    git(source, "switch", "-qc", "worker-candidate");
    git(
      source,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "worker candidate",
    );
    const evidenceRevision = git(source, "rev-parse", "HEAD");
    git(source, "switch", "-q", "main");
    const db = openPersistence(join(source, storage), []);
    const saved: State = {
      enabled: true,
      owner,
      runs: {
        A: {
          kind: "running",
          attempt: 1,
          base: revision,
          worktree: join(source, "missing-worker"),
          thread: "T-retained-worker",
          delivery: "sending",
        },
      },
    };
    db.commit(saved, "A", "fixture", "Preserve pending delivery");
    db.record("A", [
      {
        attempt: 1,
        kind: "gate",
        tool: "bun test",
        definition: null,
        outcome: "gate-passed",
        revision: evidenceRevision,
        content: evidence,
      },
    ]);
    const lesson = db.recordLesson({
      project: "alpha",
      ticket: "A",
      phase: "gate",
      sourceThread: "T-retained-worker",
      revision: evidenceRevision,
      attempt: 1,
      scope: ["src/"],
      findings: ["Check the boundary."],
      failedApproaches: [],
      questions: [],
      evidence: [sha256(evidence)],
    });
    db.close();
    const published = await cli("backup.ts", [source]);
    expect(published).toMatchObject({ code: 0 });
    const confirmed = git(remote, "rev-parse", "main");
    const withoutState = join(root, "without-state");
    git(root, "clone", source, withoutState);
    expect(await cli("backup.ts", [withoutState])).toMatchObject({
      code: 1,
      error: expect.stringMatching(/database does not exist/i),
    });
    expect(existsSync(join(withoutState, storage))).toBe(false);
    expect(await setup("--restore")).toMatchObject({
      code: 1,
      error: expect.stringMatching(/source revision/i),
    });
    expect(existsSync(statePath)).toBe(false);
    git(
      replacement,
      "fetch",
      "origin",
      "worker-candidate:refs/heads/worker-candidate",
    );

    const unexpected = () => {
      throw new Error("Recovery must not open bookkeeping or contact a worker");
    };
    const factory = createFactory(
      replacement,
      {
        create: unexpected,
        send: unexpected,
        state: unexpected,
        watch: unexpected,
        lookupDelivery: unexpected,
        requireExecution: unexpected,
      },
      unexpected,
    );
    expect(
      await factory.tick("start", owner).catch((error: unknown) => error),
    ).toMatchObject({ message: expect.stringMatching(/restore.*initialize/i) });
    expect(existsSync(statePath)).toBe(false);
    expect(await setup("--restore", { DENY_RESTORE: "1" })).toMatchObject({
      code: 1,
      error: expect.stringMatching(/restore failed/i),
    });
    expect(existsSync(statePath)).toBe(false);

    const memory = join(root, "memory");
    git(root, "clone", remote, memory);
    git(memory, "config", "user.name", "Fixture");
    git(memory, "config", "user.email", "fixture@example.invalid");
    const path = join(memory, "projects/alpha");
    const manifestPath = join(path, "manifest.json");
    const manifest = await Bun.file(manifestPath).json();
    const defects = [
      {
        file: "manifest.json",
        content: JSON.stringify({ ...manifest, projectKey: "other" }),
        error: /project/i,
      },
      {
        file: "manifest.json",
        content: JSON.stringify({ ...manifest, schemaVersion: 99 }),
        error: /schema/i,
      },
      {
        file: "manifest.json",
        content: JSON.stringify({
          ...manifest,
          applicationRevision: "b".repeat(40),
        }),
        error: /application revision/i,
      },
      { file: "state.sqlite", content: "corrupt bytes", error: /digest/i },
      {
        file: "state.sqlite",
        content: "corrupt bytes",
        manifest: { stateSHA256: sha256("corrupt bytes") },
        error: /integrity/i,
      },
      { file: "evidence.json", content: undefined, error: /missing/i },
      {
        file: "evidence.json",
        content: "{}",
        manifest: { evidenceSHA256: sha256("{}") },
        error: /coverage/i,
      },
    ];
    for (const defect of defects) {
      const file = join(path, defect.file);
      if (defect.content === undefined) await rm(file);
      else await writeFile(file, defect.content);
      if (defect.manifest)
        await writeFile(
          manifestPath,
          JSON.stringify({ ...manifest, ...defect.manifest }),
        );
      git(memory, "add", "-A");
      git(
        memory,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-qm",
        "invalid snapshot",
      );
      git(memory, "push", "origin", "main");
      expect(await setup("--restore")).toMatchObject({
        code: 1,
        error: expect.stringMatching(defect.error),
      });
      expect(existsSync(statePath)).toBe(false);
      git(memory, "-c", "commit.gpgSign=false", "revert", "--no-edit", "HEAD");
    }
    git(memory, "push", "origin", "main");
    const latest = git(remote, "rev-parse", "main");
    expect(latest).not.toBe(confirmed);
    expect((await setup("--restore", { INTERRUPT_RESTORE: "1" })).code).toBe(
      137,
    );
    const interrupted = (await readdir(join(replacement, ".git"))).find(
      (name) => name.startsWith("factory-install-"),
    );
    expect(interrupted).toBeDefined();
    expect(
      existsSync(
        join(replacement, ".git", interrupted!, "factory/state.sqlite"),
      ),
    ).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    expect(await setup("--restore")).toMatchObject({
      code: 0,
      out: expect.stringContaining(latest),
    });
    const before = await readFile(statePath);
    expect(factoryStatus(factory.directory)).toMatchObject(saved);
    expect(
      await readFile(
        join(factory.directory, "evidence", sha256(evidence)),
        "utf8",
      ),
    ).toBe(evidence);
    expect(before.includes(Buffer.from(lesson.id))).toBe(true);
    for (const action of [
      "start",
      "reconcile",
      "reload",
      "retry-create",
    ] as const)
      expect(
        await factory.tick(action, owner).catch((error: unknown) => error),
      ).toMatchObject({
        message: expect.stringMatching(
          /ownership reconciliation.*missing worktree/i,
        ),
      });
    expect(await readFile(statePath)).toEqual(before);
    expect(await setup("--restore")).toMatchObject({
      code: 1,
      error: expect.stringMatching(/existing local/i),
    });
    expect(await readFile(statePath)).toEqual(before);

    const fresh = join(root, "fresh");
    git(root, "clone", source, fresh);
    expect(
      await cli("setup-factory.ts", ["--repo", fresh, "--initialize"]),
    ).toMatchObject({ code: 0 });
    const freshDirectory = join(fresh, storage);
    const initialized = openPersistence(freshDirectory, []);
    initialized.commit(
      { ...saved, enabled: false },
      "A",
      "local",
      "Newer local state",
    );
    initialized.close();
    const local = await readFile(join(freshDirectory, "state.sqlite"));
    expect(
      await cli("setup-factory.ts", ["--repo", fresh, "--restore"]),
    ).toMatchObject({
      code: 1,
      error: expect.stringMatching(/existing local/i),
    });
    expect(await readFile(join(freshDirectory, "state.sqlite"))).toEqual(local);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
