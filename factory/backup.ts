import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { configuration } from "./native";

type Target = { repository: string; projectKey: string };
type Publication = Target & { branch: string; revision: string };
type Receipt = {
  status: "pending" | "confirmed" | "failed" | "uncertain";
  publication?: Publication;
  lastConfirmed?: Publication;
};

class BackupRefusal extends Error {}

async function command(cwd: string, executable: string, ...args: string[]) {
  const proc = Bun.spawn([executable, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("Backup subprocess failed");
  return output.trimEnd();
}

async function privateBranch(root: string, repository: string) {
  const metadata = JSON.parse(
    await command(
      root,
      "gh",
      "repo",
      "view",
      `github.com/${repository}`,
      "--json",
      "nameWithOwner,visibility,defaultBranchRef,url",
    ),
  );
  const branch = metadata.defaultBranchRef?.name;
  if (
    metadata.visibility !== "PRIVATE" ||
    typeof metadata.nameWithOwner !== "string" ||
    metadata.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
    typeof metadata.url !== "string" ||
    metadata.url.toLowerCase() !==
      `https://github.com/${repository.toLowerCase()}` ||
    typeof branch !== "string" ||
    !branch
  )
    throw new BackupRefusal(
      "Backup destination must be an accessible private repository with a default branch",
    );
  await command(root, "git", "check-ref-format", `refs/heads/${branch}`);
  return branch;
}

async function restoreOutput(workspace: string, projectKey: string) {
  const paths = ["state.sqlite", "manifest.json"].map(
    (name) => `projects/${projectKey}/${name}`,
  );
  const changes = await command(
    workspace,
    "git",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  );
  if (
    changes
      .split("\0")
      .filter(Boolean)
      .some((entry) => !paths.includes(entry.slice(3)))
  )
    throw new BackupRefusal("Backup workspace has conflicting changes");
  await command(workspace, "git", "reset", "--quiet", "HEAD", "--", ...paths);
  const tracked = (
    await command(workspace, "git", "ls-files", "-z", "--", ...paths)
  )
    .split("\0")
    .filter(Boolean);
  if (tracked.length)
    await command(
      workspace,
      "git",
      "restore",
      "--source=HEAD",
      "--worktree",
      "--",
      ...tracked,
    );
  await command(workspace, "git", "clean", "-f", "--", ...paths);
}

async function prepareWorkspace(
  directory: string,
  target: Target,
  branch: string,
) {
  const workspace = join(directory, "repository");
  const url = `https://github.com/${target.repository}.git`;
  if (existsSync(workspace)) {
    if (
      (await command(
        workspace,
        "git",
        "config",
        "--get",
        "remote.origin.url",
      )) !== url
    )
      throw new BackupRefusal(
        "Backup destination changed; preserve and inspect the previous workspace",
      );
    await restoreOutput(workspace, target.projectKey);
  } else {
    await command(
      directory,
      "git",
      "clone",
      "--single-branch",
      "--branch",
      branch,
      "--",
      url,
      workspace,
    );
  }
  return workspace;
}

async function remoteContains(workspace: string, publication: Publication) {
  const ref = `refs/remotes/origin/${publication.branch}`;
  await command(
    workspace,
    "git",
    "fetch",
    "origin",
    `+refs/heads/${publication.branch}:${ref}`,
  );
  if (
    (await command(
      workspace,
      "git",
      "rev-parse",
      `--disambiguate=${publication.revision}`,
    )) !== publication.revision
  )
    return false;
  const remote = await command(workspace, "git", "rev-parse", ref);
  return (
    (await command(
      workspace,
      "git",
      "merge-base",
      publication.revision,
      remote,
    )) === publication.revision
  );
}

async function commitIdentity(workspace: string) {
  try {
    await command(workspace, "git", "var", "GIT_AUTHOR_IDENT");
    await command(workspace, "git", "var", "GIT_COMMITTER_IDENT");
    return [];
  } catch {
    return [
      "-c",
      "user.name=Factory backup",
      "-c",
      "user.email=factory@localhost",
    ];
  }
}

async function rebaseBackup(
  workspace: string,
  branch: string,
  identity: string[],
) {
  try {
    await command(
      workspace,
      "git",
      ...identity,
      "rebase",
      "--no-autostash",
      `refs/remotes/origin/${branch}`,
    );
  } catch {
    await command(workspace, "git", "rebase", "--abort");
    throw new BackupRefusal(
      "Backup branch has conflicting remote changes; inspect the retained workspace",
    );
  }
}

async function publish(
  workspace: string,
  publication: Publication,
  lastConfirmed: Publication | undefined,
  save: (receipt: Receipt) => Promise<void>,
): Promise<Receipt> {
  let receipt: Receipt = { status: "pending", publication, lastConfirmed };
  await save(receipt);
  if (!(await remoteContains(workspace, publication))) {
    try {
      await command(
        workspace,
        "git",
        "push",
        "origin",
        `HEAD:refs/heads/${publication.branch}`,
      );
    } catch {
      /* Confirm even when the push response was lost. */
    }
  }
  try {
    receipt = (await remoteContains(workspace, publication))
      ? { status: "confirmed", lastConfirmed: publication }
      : { ...receipt, status: "failed" };
  } catch {
    receipt.status = "uncertain";
  }
  await save(receipt);
  return receipt;
}

async function reconcilePublication(
  workspace: string,
  target: Pick<Publication, "repository" | "branch">,
  receipt: Receipt,
  save: (receipt: Receipt) => Promise<void>,
) {
  if (
    (receipt.status !== "pending" && receipt.status !== "uncertain") ||
    !receipt.publication
  )
    return true;
  try {
    if (
      receipt.publication.repository !== target.repository ||
      receipt.publication.branch !== target.branch
    )
      throw new BackupRefusal("Pending backup destination changed");
    if (await remoteContains(workspace, receipt.publication))
      await save({ status: "confirmed", lastConfirmed: receipt.publication });
    return true;
  } catch (error) {
    await save({ ...receipt, status: "uncertain" });
    if (error instanceof BackupRefusal) throw error;
    return false;
  }
}

async function snapshotDatabase(root: string, directory: string) {
  const database = join(directory, "..", "state.sqlite");
  if (!existsSync(database))
    throw new BackupRefusal("Factory database does not exist");
  const snapshot = join(directory, "snapshot.sqlite");
  await rm(snapshot, { force: true });
  // VACUUM INTO runs in another process so SQLite work cannot block the plugin heartbeat.
  const schemaVersion = Number(
    await command(
      root,
      "bun",
      "-e",
      `
      const {Database}=require("bun:sqlite");
      const source=new Database(process.argv[1],{readonly:true});
      source.run("PRAGMA busy_timeout=5000");
      source.run("VACUUM INTO ?",[process.argv[2]]);
      source.close();
      const db=new Database(process.argv[2],{readonly:true});
      const integrity=db.query("PRAGMA integrity_check").all();
      if(integrity.length!==1 || integrity[0].integrity_check!=="ok") throw Error("Integrity check failed");
      console.log(db.query("PRAGMA user_version").get().user_version);
      db.close();
    `,
      database,
      snapshot,
    ),
  );
  if (schemaVersion !== 1 && schemaVersion !== 2)
    throw new BackupRefusal("Unsupported backup schema");
  return { snapshot, schemaVersion };
}

/** Save and confirm a consistent private snapshot. Subprocess diagnostics never leave this boundary.
 * @throws On denied configuration, contention, unsafe metadata, conflicts, or local I/O failure.
 */
export async function backup(root: string): Promise<Receipt> {
  root = resolve(root);
  const config = await configuration(root);
  if (!config.backup || !config.backupAllowed)
    throw new Error(
      "Configure backup and grant permissions.backup before backing up",
    );
  const target = config.backup;
  const git = (cwd: string, ...args: string[]) => command(cwd, "git", ...args);
  const directory = join(
    await git(root, "rev-parse", "--absolute-git-dir"),
    "factory",
    "backup",
  );
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      "Backup already locked; inspect any interrupted backup before removing its lock",
    );
  }
  const receiptPath = join(directory, "receipt.json");
  let receipt: Receipt = { status: "pending" };
  const save = async (next: Receipt = receipt) => {
    receipt = next;
    await writeFile(`${receiptPath}.tmp`, JSON.stringify(receipt));
    await rename(`${receiptPath}.tmp`, receiptPath);
  };
  try {
    if (existsSync(receiptPath))
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const branch = await privateBranch(root, target.repository);
    const workspace = await prepareWorkspace(directory, target, branch);
    const fetch = () =>
      git(
        workspace,
        "fetch",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      );
    if (
      !(await reconcilePublication(
        workspace,
        { ...target, branch },
        receipt,
        save,
      ))
    )
      return receipt;
    await fetch();
    const identity = await commitIdentity(workspace);
    await rebaseBackup(workspace, branch, identity);
    const { snapshot, schemaVersion } = await snapshotDatabase(root, directory);
    const path = join(workspace, "projects", target.projectKey);
    // Reject remote symlinks before writing the allowlisted project files.
    const entries = await git(
      workspace,
      "ls-files",
      "--stage",
      "--",
      "projects",
    );
    if (entries.split("\n").some((line) => line.startsWith("120000 ")))
      throw new BackupRefusal("Backup repository contains project symlinks");
    await mkdir(path, { recursive: true });
    await copyFile(snapshot, join(path, "state.sqlite"));
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        projectKey: target.projectKey,
        schemaVersion,
        applicationRevision: await git(root, "rev-parse", "HEAD"),
      }) + "\n",
    );
    await git(
      workspace,
      "add",
      "--",
      `projects/${target.projectKey}/state.sqlite`,
      `projects/${target.projectKey}/manifest.json`,
    );
    if (await git(workspace, "diff", "--cached", "--name-only")) {
      await git(
        workspace,
        ...identity,
        "commit",
        "-m",
        "Back up factory state",
      ).catch(() => {
        throw new BackupRefusal(
          "Backup commit was refused; inspect commit identity and signing configuration",
        );
      });
    }
    const publication = {
      ...target,
      branch,
      revision: await git(workspace, "rev-parse", "HEAD"),
    };
    return await publish(workspace, publication, receipt.lastConfirmed, save);
  } catch (error) {
    receipt =
      receipt.publication &&
      (receipt.status === "pending" || receipt.status === "uncertain")
        ? { ...receipt, status: "uncertain" }
        : { status: "failed", lastConfirmed: receipt.lastConfirmed };
    await save();
    throw error instanceof BackupRefusal
      ? error
      : new Error(
          "Backup failed; inspect local configuration, database, and repository access",
        );
  } finally {
    await rm(join(directory, "snapshot.sqlite"), { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith("-"))
      throw new Error("Usage: bun factory/backup.ts /local/project/root");
    const receipt = await backup(process.argv[2]);
    console.log(JSON.stringify(receipt));
    if (receipt.status !== "confirmed") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backup failed");
    process.exitCode = 1;
  }
}
