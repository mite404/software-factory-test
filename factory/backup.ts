import { constants, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configuration } from "./native";
import {
  backupCoverage,
  factoryRecords,
  hasRestoreHold,
  installFactoryStorage,
  restoredSchema,
  restoreHoldFile,
  sha256,
} from "./persistence";

type Target = { repository: string; projectKey: string };
type Publication = Target & {
  branch: string;
  revision: string;
  // Receipts written before coverage manifests lack these fields.
  manifestSHA256?: string;
  applicationRevision?: string;
};
type Confirmation = Publication & { confirmedAt?: string };
type Receipt = {
  status: "pending" | "confirmed" | "failed" | "uncertain";
  publication?: Publication;
  lastConfirmed?: Confirmation;
};
type Coverage = ReturnType<typeof backupCoverage>;
const outputNames = ["state.sqlite", "manifest.json", "evidence.json"];
const credentialSignature =
  /\b(?:gh[pousr]_|github_pat_|sk[-_]|xox[baprs]-|AKIA)[\w-]{12,}|\bBearer\s+[\w.=-]{16,}|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|:\/\/[^\s/:]+:[^\s/]+@/i;

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
  const paths = outputNames.map((name) => `projects/${projectKey}/${name}`);
  const changes = await command(
    workspace,
    "git",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
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
  await command(workspace, "git", "clean", "-fx", "--", ...paths);
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
  lastConfirmed: Confirmation | undefined,
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
        `${publication.revision}:refs/heads/${publication.branch}`,
      );
    } catch {
      /* Confirm even when the push response was lost. */
    }
  }
  try {
    receipt = (await remoteContains(workspace, publication))
      ? confirmed(publication)
      : { ...receipt, status: "failed" };
  } catch {
    receipt.status = "uncertain";
  }
  await save(receipt);
  return receipt;
}

function confirmed(publication: Publication): Receipt {
  return {
    status: "confirmed",
    lastConfirmed: { ...publication, confirmedAt: new Date().toISOString() },
  };
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
    await save(
      (await remoteContains(workspace, receipt.publication))
        ? confirmed(receipt.publication)
        : { status: "failed", lastConfirmed: receipt.lastConfirmed },
    );
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
  // Keep SQLite capture, integrity checks, and the field scan off the plugin's event loop.
  const result = await command(
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
      const signature=${credentialSignature};
      const tables=db.query("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table'").all();
      for(const {name} of tables) {
        const quoted='"'+name.replaceAll('"','""')+'"';
        for(const row of db.query("SELECT * FROM main."+quoted).iterate()) {
          if(Object.values(row).some(value=>typeof value==="string" && signature.test(value))) {
            console.log("credential-signature");
            db.close();
            process.exit(0);
          }
        }
      }
      console.log(db.query("PRAGMA user_version").get().user_version);
      db.close();
    `,
    database,
    snapshot,
  );
  if (result === "credential-signature")
    throw new BackupRefusal(
      "SQLite snapshot may contain credentials; backup refused",
    );
  const schemaVersion = Number(result);
  if (schemaVersion !== 1 && schemaVersion !== 2)
    throw new BackupRefusal("Unsupported backup schema");
  return { snapshot, schemaVersion };
}

async function evidenceArchive(
  directory: string,
  evidence: Coverage["evidence"],
) {
  const archive = new Map<string, string>();
  const evidenceDir = join(directory, "evidence");
  try {
    if (evidence.length && !(await lstat(evidenceDir)).isDirectory())
      throw new Error("Not an evidence directory");
    for (const { sha256: digest, bytes } of evidence) {
      const saved = archive.get(digest);
      if (saved !== undefined) {
        if (Buffer.byteLength(saved, "base64") !== bytes)
          throw new Error("Evidence size mismatch");
        continue;
      }
      archive.set(digest, await readEvidence(evidenceDir, digest, bytes));
    }
  } catch (error) {
    if (error instanceof BackupRefusal) throw error;
    throw new BackupRefusal(
      "Required evidence is missing or corrupt; backup refused",
    );
  }
  return JSON.stringify(Object.fromEntries(archive));
}

async function readEvidence(directory: string, digest: string, bytes: number) {
  const file = await open(
    join(directory, digest),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== bytes)
      throw new Error("Invalid evidence file");
    const content = await file.readFile();
    if (content.length !== bytes || sha256(content) !== digest)
      throw new Error("Evidence digest mismatch");
    if (credentialSignature.test(content.toString("utf8")))
      throw new BackupRefusal(
        "Required evidence may contain credentials; backup refused",
      );
    return content.toString("base64");
  } finally {
    await file.close();
  }
}

async function fileDigest(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const bytes of Bun.file(path).stream()) hasher.update(bytes);
  return hasher.digest("hex");
}

async function coversLesson(
  workspace: string,
  publication: Confirmation | undefined,
  lessonID: string | undefined,
) {
  if (lessonID === undefined || !publication?.manifestSHA256) return false;
  if (!(await remoteContains(workspace, publication))) return false;
  const manifest = await command(
    workspace,
    "git",
    "show",
    `${publication.revision}:projects/${publication.projectKey}/manifest.json`,
  );
  if (sha256(manifest) !== publication.manifestSHA256) return false;
  const parsed: Pick<Coverage, "lessons"> = JSON.parse(manifest);
  return parsed.lessons.some(({ id }) => id === lessonID);
}

const git = (cwd: string, ...args: string[]) => command(cwd, "git", ...args);

async function extractSnapshot(
  workspace: string,
  staged: string,
  projectKey: string,
) {
  const paths = outputNames.map((name) => `projects/${projectKey}/${name}`);
  const revision = await git(
    workspace,
    "log",
    "-1",
    "--first-parent",
    "--format=%H",
    "HEAD",
    "--",
    ...paths,
  );
  if (!revision)
    throw new BackupRefusal("Expected project snapshot is missing");
  const entries = (
    await git(workspace, "ls-tree", "-r", revision, "--", ...paths)
  ).split("\n");
  if (
    entries.length !== paths.length ||
    entries.some((entry) => !entry.startsWith("100644 blob "))
  )
    throw new BackupRefusal(
      "Required snapshot files are missing or not regular files",
    );
  for (const name of outputNames) {
    const proc = Bun.spawn(
      ["git", "cat-file", "blob", `${revision}:projects/${projectKey}/${name}`],
      {
        cwd: workspace,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const [status] = await Promise.all([
      proc.exited,
      Bun.write(join(staged, name), new Response(proc.stdout)),
    ]);
    if (status !== 0)
      throw new BackupRefusal("Required snapshot file is unreadable");
  }
  return revision;
}

function snapshotObject(source: string) {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BackupRefusal("Invalid snapshot metadata");
  return value as Record<string, unknown>;
}

async function restoreEvidence(
  staged: string,
  archive: string,
  evidence: Coverage["evidence"],
) {
  const decoded = snapshotObject(archive);
  if (
    Object.keys(decoded).length !==
    new Set(evidence.map(({ sha256 }) => sha256)).size
  )
    throw new BackupRefusal(
      "Snapshot evidence coverage is incomplete or unexpected",
    );
  const directory = join(staged, "evidence");
  await mkdir(directory, { mode: 0o700 });
  for (const { sha256: digest, bytes } of evidence) {
    const encoded = decoded[digest];
    if (typeof encoded !== "string")
      throw new BackupRefusal("Required snapshot evidence is missing");
    const content = Buffer.from(encoded, "base64");
    if (
      content.length !== bytes ||
      content.toString("base64") !== encoded ||
      sha256(content) !== digest
    )
      throw new BackupRefusal(
        "Snapshot evidence digest or size does not match",
      );
    await writeFile(join(directory, digest), content, { mode: 0o600 });
  }
}

function snapshotManifest(source: string, projectKey: string) {
  const manifest = snapshotObject(source);
  if (manifest.projectKey !== projectKey)
    throw new BackupRefusal("Snapshot project identity does not match");
  if (
    manifest.manifestVersion !== 1 ||
    (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2)
  )
    throw new BackupRefusal("Unsupported snapshot manifest or database schema");
  if (
    typeof manifest.applicationRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.applicationRevision)
  )
    throw new BackupRefusal("Invalid snapshot application revision");
  return {
    manifest,
    applicationRevision: manifest.applicationRevision,
    schemaVersion: manifest.schemaVersion,
  };
}

async function validateSourceRevisions(
  root: string,
  { evidence, lessons }: Coverage,
) {
  for (const revision of new Set(
    [...evidence, ...lessons].map((item) => item.revision),
  )) {
    const type = await git(
      root,
      "--no-replace-objects",
      "cat-file",
      "-t",
      revision,
    ).catch(() => null);
    if (type !== "commit")
      throw new BackupRefusal(
        `Snapshot source revision ${revision} is not a commit in this checkout`,
      );
  }
}

async function validateSnapshot(
  root: string,
  staged: string,
  projectKey: string,
) {
  const manifestText = await readFile(join(staged, "manifest.json"), "utf8");
  const { applicationRevision, schemaVersion, manifest } = snapshotManifest(
    manifestText,
    projectKey,
  );
  await git(
    root,
    "merge-base",
    "--is-ancestor",
    applicationRevision,
    "HEAD",
  ).catch(() => {
    throw new BackupRefusal(
      "Snapshot application revision is not in this checkout's history",
    );
  });
  const snapshot = join(staged, "state.sqlite");
  const archive = await readFile(join(staged, "evidence.json"), "utf8");
  if (
    (await fileDigest(snapshot)) !== manifest.stateSHA256 ||
    sha256(archive) !== manifest.evidenceSHA256
  )
    throw new BackupRefusal("Snapshot payload digest does not match");
  if (restoredSchema(staged) !== schemaVersion)
    throw new BackupRefusal(
      "Snapshot database schema does not match its manifest",
    );
  factoryRecords(staged);
  const { evidence, lessons } = backupCoverage(snapshot);
  if (
    !isDeepStrictEqual(manifest.evidence, evidence) ||
    !isDeepStrictEqual(manifest.lessons, lessons)
  )
    throw new BackupRefusal("Snapshot coverage does not match its database");
  await validateSourceRevisions(root, { evidence, lessons });
  await restoreEvidence(staged, archive, evidence);
  return { applicationRevision, manifestSHA256: sha256(manifestText) };
}

/** Restore the configured project's latest remote snapshot without opening factory execution.
 * @throws On invalid input, unavailable backup, or existing local factory files.
 */
export async function restoreBackup(root: string, directory: string) {
  const { backup: target, backupAllowed } = await configuration(root);
  if (!target || !backupAllowed)
    throw new Error(
      "Configure backup and grant permissions.backup before restoring",
    );
  return installFactoryStorage(directory, async (staged, temporary) => {
    try {
      const branch = await privateBranch(root, target.repository);
      const workspace = join(temporary, "repository");
      await git(
        temporary,
        "clone",
        "--bare",
        "--single-branch",
        "--branch",
        branch,
        "--",
        `https://github.com/${target.repository}.git`,
        workspace,
      );
      const revision = await extractSnapshot(
        workspace,
        staged,
        target.projectKey,
      );
      const source = await validateSnapshot(root, staged, target.projectKey);
      const receipt = { ...target, branch, revision, ...source };
      await rm(join(staged, "manifest.json"));
      await rm(join(staged, "evidence.json"));
      await writeFile(join(staged, restoreHoldFile), JSON.stringify(receipt), {
        mode: 0o600,
      });
      return receipt;
    } catch (error) {
      if (error instanceof BackupRefusal) throw error;
      throw new Error(
        "Restore failed; inspect repository access and snapshot integrity",
      );
    }
  });
}

async function capture(
  root: string,
  directory: string,
  target: Target,
  lessonID?: string,
) {
  const applicationRevision = await git(root, "rev-parse", "HEAD");
  const { snapshot, schemaVersion } = await snapshotDatabase(root, directory);
  if ((await git(root, "rev-parse", "HEAD")) !== applicationRevision)
    throw new BackupRefusal(
      "Application revision changed during backup; retry",
    );
  const coverage = backupCoverage(snapshot);
  if (
    lessonID !== undefined &&
    !coverage.lessons.some(({ id }) => id === lessonID)
  )
    throw new BackupRefusal(
      "Checkpoint lesson is not recorded in the snapshot",
    );
  const archive = await evidenceArchive(dirname(directory), coverage.evidence);
  const manifest = JSON.stringify({
    manifestVersion: 1,
    projectKey: target.projectKey,
    schemaVersion,
    applicationRevision,
    stateSHA256: await fileDigest(snapshot),
    evidenceSHA256: sha256(archive),
    ...coverage,
  });
  return { snapshot, manifest, archive, applicationRevision };
}

async function commitSnapshot(
  workspace: string,
  lock: string,
  target: Target,
  identity: string[],
  { snapshot, manifest, archive }: Awaited<ReturnType<typeof capture>>,
) {
  const projectPath = `projects/${target.projectKey}`;
  const path = join(workspace, projectPath);
  const entries = await git(workspace, "ls-files", "--stage", "--", "projects");
  if (entries.split("\n").some((line) => /^(120000|160000) /.test(line)))
    throw new BackupRefusal(
      "Backup repository contains project symlinks or submodules",
    );
  await mkdir(path, { recursive: true });
  await rename(snapshot, join(path, "state.sqlite"));
  for (const [name, content] of Object.entries({
    "evidence.json": archive,
    "manifest.json": manifest,
  })) {
    await writeFile(join(lock, name), content);
    await rename(join(lock, name), join(path, name));
  }
  const paths = outputNames.map((name) => `${projectPath}/${name}`);
  await git(workspace, "add", "--", ...paths);
  const blobs = (
    await Promise.all(
      paths.map((file) => git(workspace, "hash-object", "--no-filters", file)),
    )
  ).join("\n");
  if (
    (await git(workspace, "rev-parse", ...paths.map((file) => `:${file}`))) !==
    blobs
  )
    throw new BackupRefusal(
      "Git attributes changed snapshot bytes; backup refused",
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
  const revision = await git(
    workspace,
    "log",
    "-1",
    "--format=%H",
    "HEAD",
    "--",
    ...paths,
  );
  if (
    (await git(
      workspace,
      "rev-parse",
      ...paths.map((file) => `${revision}:${file}`),
    )) !== blobs
  )
    throw new BackupRefusal("Committed snapshot bytes differ; backup refused");
  return revision;
}

function sameDestination(
  previous: Confirmation | undefined,
  target: Target & { branch: string },
) {
  return previous &&
    previous.repository === target.repository &&
    previous.projectKey === target.projectKey &&
    previous.branch === target.branch
    ? previous
    : undefined;
}

async function backupDirectory(root: string) {
  const directory = join(
    await git(root, "rev-parse", "--absolute-git-dir"),
    "factory",
    "backup",
  );
  if (hasRestoreHold(dirname(directory)))
    throw new Error(
      "Restored factory requires ownership reconciliation before backup",
    );
  if (!existsSync(join(dirname(directory), "state.sqlite")))
    throw new BackupRefusal("Factory database does not exist");
  await mkdir(directory, { recursive: true });
  return directory;
}

/** Save and confirm a consistent private snapshot. Subprocess diagnostics never leave this boundary.
 * @throws On denied configuration, contention, unsafe metadata, conflicts, or local I/O failure.
 */
export async function backup(
  root: string,
  lessonID?: string,
): Promise<Receipt> {
  root = resolve(root);
  const config = await configuration(root);
  if (!config.backup || !config.backupAllowed)
    throw new Error(
      "Configure backup and grant permissions.backup before backing up",
    );
  const target = config.backup;
  const directory = await backupDirectory(root);
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
    const destination = { ...target, branch };
    const workspace = await prepareWorkspace(directory, target, branch);
    const fetch = () =>
      git(
        workspace,
        "fetch",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      );
    if (!(await reconcilePublication(workspace, destination, receipt, save)))
      return receipt;
    const previous = sameDestination(receipt.lastConfirmed, destination);
    if (await coversLesson(workspace, previous, lessonID))
      return { status: "confirmed", lastConfirmed: previous };
    await fetch();
    const identity = await commitIdentity(workspace);
    await rebaseBackup(workspace, branch, identity);
    const captured = await capture(root, directory, target, lessonID);
    const publication = {
      ...destination,
      revision: await commitSnapshot(
        workspace,
        lock,
        target,
        identity,
        captured,
      ),
      manifestSHA256: sha256(captured.manifest),
      applicationRevision: captured.applicationRevision,
    };
    if (
      receipt.status === "confirmed" &&
      previous?.revision === publication.revision &&
      previous.manifestSHA256 === publication.manifestSHA256 &&
      (await remoteContains(workspace, previous))
    )
      return receipt;
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
