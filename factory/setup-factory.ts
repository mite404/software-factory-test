#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  configuration,
  localPath,
  parseSetup,
  parseWorkerEffort,
  reviewerModel,
} from "./native";

function discoverStore() {
  const skill = execFileSync("amp", ["skill", "info", "poteto-mode"], {
    encoding: "utf8",
  });
  const uri = skill.match(/^Path: (file:\/\/\S+)$/m)?.[1];
  if (!uri)
    throw new Error(
      "Install poteto-mode or pass --store /path/to/orch/store.ts",
    );
  return join(fileURLToPath(uri), "scripts/orch/store.ts");
}

function resolveStore(path?: string) {
  const store = path ? resolve(path) : discoverStore();
  if (!existsSync(store))
    throw new Error(
      "Install poteto-mode or pass --store /path/to/orch/store.ts",
    );
  return store;
}

async function requireConfiguration(root: string) {
  if (!existsSync(join(root, ".factory.json")))
    throw new Error("Cannot refresh before factory setup");
  await configuration(root);
}

async function checkOrReuse(root: string, pluginPath: string, check: boolean) {
  if (!check && !existsSync(join(root, ".factory.json"))) return false;
  await configuration(root);
  await access(pluginPath);
  process.stdout.write(
    check
      ? "SETUP OK (execution remains separately controlled)\n"
      : "SETUP UNCHANGED\n",
  );
  return true;
}

async function existingSetup(
  root: string,
  pluginPath: string,
  check: boolean,
  refresh: boolean,
) {
  if (check && refresh)
    throw new Error("--check cannot be combined with --refresh");
  if (refresh) {
    await requireConfiguration(root);
    return false;
  }
  return checkOrReuse(root, pluginPath, check);
}

async function bundlePlugin(root: string, store: string) {
  const temporary = await mkdtemp(join(tmpdir(), "factory-bundle-"));
  try {
    const entry = join(temporary, "entry.ts");
    await writeFile(
      entry,
      `import register from ${JSON.stringify(join(import.meta.dir, "plugin.ts"))};\nimport {openStore} from ${JSON.stringify(store)};\nexport const description = "Sequential local factory dispatch with durable claims and revision verification";\nexport default (amp) => register(amp, ${JSON.stringify(root)}, openStore);\n`,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      minify: false,
    });
    if (!result.success || !result.outputs[0])
      throw new Error(
        `Bundle failed: ${result.logs.map((log) => log.message).join("\n")}`,
      );
    return result.outputs[0].text();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function refreshPlugin(pluginPath: string, plugin: string) {
  const temporary = `${pluginPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, plugin, { flag: "wx" });
    await rename(temporary, pluginPath);
  } finally {
    await rm(temporary, { force: true });
  }
  process.stdout.write("REFRESH OK; reload the factory plugin.\n");
}

function options() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: "." },
      prd: { type: "string" },
      verify: { type: "string" },
      setup: { type: "string" },
      "setup-timeout-ms": { type: "string" },
      scope: { type: "string", multiple: true },
      "worker-model": { type: "string", default: "openai/gpt-6.1-sol" },
      "worker-effort": { type: "string", default: "medium" },
      review: { type: "boolean", default: false },
      store: { type: "string" },
      check: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
    },
  });
  if (values.review) reviewerModel(values["worker-model"]);
  const { command: setup, timeoutMs: setupTimeoutMs } =
    parseSetup(
      values.setup,
      values["setup-timeout-ms"] === undefined
        ? undefined
        : Number(values["setup-timeout-ms"]),
    ) ?? {};
  return { ...values, setup, setupTimeoutMs };
}

function repository(path: string) {
  const root = resolve(path);
  const top = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  if (root !== top) throw new Error("--repo must name the Git repository root");
  execFileSync("amp", ["--version"], { stdio: "pipe" });
  return root;
}

async function initialInputs(root: string, values: ReturnType<typeof options>) {
  if (![values.prd, values.verify, values.scope?.length].every(Boolean))
    throw new Error("Provide --prd, --verify, and --scope");
  await readFile(localPath(root, values.prd!), "utf8");
  for (const path of values.scope!) localPath(root, path);
}

async function excludePlugin(root: string) {
  const excludePath = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" },
  ).trim();
  const exclude = resolve(root, excludePath);
  await mkdir(resolve(exclude, ".."), { recursive: true });
  const old = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  await writeFile(exclude, old + "\n/.amp/plugins/software-factory.js\n");
}

async function main() {
  const values = options();
  const workerEffort = parseWorkerEffort(values["worker-effort"]);
  const root = repository(values.repo);
  const configPath = join(root, ".factory.json");
  const pluginPath = join(root, ".amp/plugins/software-factory.js");
  const refresh = values.refresh;
  if (await existingSetup(root, pluginPath, values.check, refresh)) return;
  if (!refresh) await initialInputs(root, values);
  const store = resolveStore(values.store);
  const plugin = await bundlePlugin(root, store);
  await mkdir(join(root, ".amp/plugins"), { recursive: true });
  if (refresh) {
    await refreshPlugin(pluginPath, plugin);
    return;
  }
  const config = {
    version: 1,
    prd: values.prd,
    tickets: ".factory-tickets.json",
    verify: values.verify,
    setup: values.setup,
    setupTimeoutMs: values.setupTimeoutMs,
    scope: values.scope,
    capacity: 1,
    mode: "bug-finding",
    workerModel: values["worker-model"],
    workerEffort,
    review: values.review,
    orchestratorModel: "openai/gpt-6.1-sol",
    permissions: {
      execute: false,
      publish: false,
      externalTickets: false,
    },
    bookkeepingSHA256: createHash("sha256")
      .update(await readFile(store))
      .digest("hex"),
  };
  async function install() {
    const tickets = join(root, config.tickets);
    if (existsSync(pluginPath) || existsSync(tickets))
      throw new Error(
        "Setup refuses to overwrite existing plugin or ticket files",
      );
    await writeFile(pluginPath, plugin, { flag: "wx" });
    await writeFile(tickets, "[]\n", { flag: "wx" });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
    });
    await excludePlugin(root);
    process.stdout.write(
      "SETUP OK; execution disabled. Review .factory.json and .factory-tickets.json.\n",
    );
  }
  await install();
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
