#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  checkVerificationTools,
  configuration,
  effectiveDefinition,
  lightRole,
  localPath,
  migrateDefinition,
  parseSetup,
  parseWorkerEffort,
} from "./native";
import { hasConfigDefinition, type Check } from "./config";
import { reviewerModel } from "./persistence";
import { installControlToken } from "./control-token";

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

async function requireInstallation(
  root: string,
  check: boolean,
  checks?: Check[],
) {
  if (!check) return;
  await checkVerificationTools(root, checks);
  for (const file of dashboardFiles)
    await access(join(root, dashboardDir, file));
  if ((await servicesAppend(root)) !== "")
    throw new Error(
      "Dashboard service is not declared in .amp/services.yaml; run --refresh",
    );
}

function hasDefinition(root: string) {
  return (
    hasConfigDefinition(root) ||
    [".factory.json", "factory/definition.yaml"].some((path) =>
      existsSync(join(root, path)),
    )
  );
}

async function requireInstalledPolicy(root: string, pluginPath: string) {
  const installed = await readFile(pluginPath, "utf8");
  const newline = installed.indexOf("\n");
  const expected = installationHeader(
    root,
    await policySource(),
    installed.slice(newline + 1),
  );
  if (installed.slice(0, newline) !== expected)
    throw new Error(
      "Installed policy missing or mismatched; run --refresh, then reload and verify policy-status",
    );
}

async function checkOrReuse(root: string, pluginPath: string, check: boolean) {
  if (!check && !hasDefinition(root)) return false;
  const config = await configuration(root);
  await requireInstalledPolicy(root, pluginPath);
  await requireInstallation(root, check, config.checks);
  process.stdout.write(
    check
      ? "FILES OK; loaded policy UNVERIFIED. Call policy-status in the owner runtime.\n"
      : "SETUP UNCHANGED\n",
  );
  return true;
}

const serviceName = "factory-dashboard";
// Generated, like the plugin: git-excluded and rebuilt by --refresh. The service runs only this copy.
const dashboardDir = ".amp/factory";
const dashboardFiles = ["dashboard.js", "dashboard.html"];

// Declaring the dashboard grants no execution, schedule, ticket or push permission.
// The command is constant and names only a repository-local file, so it needs no shell quoting.
function dashboardService() {
  return {
    command: `bun ${dashboardDir}/dashboard.js --repo .`,
    port: 4310,
    health: "/api/status",
    portal: {
      title: "Factory dashboard",
      description: "Read-only factory status served on the API origin.",
    },
  };
}

// The parse is only a reader; parsesTo proves the appended file before anything is written.
function parseServices(text: string) {
  const top = (Bun.YAML.parse(text.trim() || "{}") ?? {}) as {
    services?: Record<string, unknown>;
  };
  return { top, declared: top.services ?? {} };
}

function serviceEntry(old: string, hasServices: boolean, want: object) {
  const entry = Bun.YAML.stringify({ [serviceName]: want }, null, 2).replace(
    /^(?=.)/gm,
    "  ",
  );
  return (
    (/(^|\n)$/.test(old) ? "" : "\n") +
    (hasServices ? "" : "services:\n") +
    entry
  );
}

function parsesTo(text: string, expected: unknown) {
  try {
    return isDeepStrictEqual(Bun.YAML.parse(text), expected);
  } catch {
    return false;
  }
}

async function readText(path: string) {
  return existsSync(path) ? readFile(path, "utf8") : "";
}

/**
 * Text to append to the repository's .amp/services.yaml to declare the dashboard; "" when it is already declared.
 * The application's own bytes are never rewritten, only appended to.
 * @throws On a different entry of that name, or a file that cannot be appended to without reformatting it.
 */
async function servicesAppend(root: string) {
  const want = dashboardService();
  const old = await readText(join(root, ".amp/services.yaml"));
  const { top, declared } = parseServices(old);
  if (Object.hasOwn(declared, serviceName)) {
    if (isDeepStrictEqual(declared[serviceName], want)) return "";
    throw new Error(
      `.amp/services.yaml already declares a different ${serviceName}; resolve it by hand`,
    );
  }
  const append = serviceEntry(old, top.services !== undefined, want);
  const expected = { ...top, services: { ...declared, [serviceName]: want } };
  if (!parsesTo(old + append, expected))
    throw new Error(
      `Cannot append ${serviceName} to .amp/services.yaml without reformatting it; add it by hand`,
    );
  return append;
}

async function installServices(root: string, append: string) {
  if (append === "") return;
  await mkdir(join(root, ".amp"), { recursive: true });
  await appendFile(join(root, ".amp/services.yaml"), append);
}

// Self-contained copy of the dashboard so the installed service never reaches into the source checkout.
async function bundleDashboard() {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "dashboard.ts")],
    root: import.meta.dir,
    target: "bun",
    minify: false,
  });
  if (!result.success || !result.outputs[0])
    throw new Error(
      `Bundle failed: ${result.logs.map((log) => log.message).join("\n")}`,
    );
  return {
    "dashboard.js": await result.outputs[0].text(),
    "dashboard.html": await readFile(
      join(import.meta.dir, "dashboard.html"),
      "utf8",
    ),
  };
}

async function installDashboard(
  root: string,
  files: Awaited<ReturnType<typeof bundleDashboard>>,
) {
  const gitDirectory = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).trim();
  installControlToken(join(gitDirectory, "factory"));
  await mkdir(join(root, dashboardDir), { recursive: true });
  for (const [name, text] of Object.entries(files))
    await replaceFile(join(root, dashboardDir, name), text);
}

async function existingSetup(
  root: string,
  pluginPath: string,
  values: ReturnType<typeof options>,
) {
  if (await definitionOperation(root, values)) return true;
  if (values.refresh) {
    await configuration(root);
    return false;
  }
  return checkOrReuse(root, pluginPath, values.check);
}

// Source identity is independent of generated files and of model-supplied metadata.
async function policySource() {
  const hash = createHash("sha256");
  const files = (await readdir(import.meta.dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  for (const name of files) {
    hash.update(name + "\0");
    hash.update(await readFile(join(import.meta.dir, name)));
  }
  return hash.digest("hex");
}

function installationHeader(root: string, policy: string, body: string) {
  return `// factory-installation ${JSON.stringify({ root, policy, bundleSHA256: createHash("sha256").update(body).digest("hex") })}`;
}

async function bundlePlugin(root: string, store: string) {
  const temporary = await mkdtemp(join(tmpdir(), "factory-bundle-"));
  try {
    const policy = await policySource();
    const entry = join(temporary, "entry.ts");
    await writeFile(
      entry,
      `import register from ${JSON.stringify(join(import.meta.dir, "plugin.ts"))};\nimport {openStore} from ${JSON.stringify(store)};\nexport const description = "Sequential local factory dispatch with durable claims and revision verification";\nexport default (amp) => register(amp, ${JSON.stringify(root)}, openStore, {policy: ${JSON.stringify(policy)}});\n`,
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
    // Bun comments each module with its path; the random temp directory would change every refresh.
    const bundled = (await result.outputs[0].text()).replaceAll(
      relative(process.cwd(), entry),
      "factory-bundle/entry.ts",
    );
    const body = `// @amp-agent-mode {"key":"factory-foreman","label":"Factory Foreman"}\n${bundled}`;
    return `${installationHeader(root, policy, body)}\n${body}`;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function replaceFile(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function refreshPlugin(pluginPath: string, plugin: string) {
  await replaceFile(pluginPath, plugin);
  process.stdout.write("REFRESH OK; reload the factory plugin.\n");
}

// Without --light-worker-model the definition keeps today's single lane.
function workerLanes(
  model: string | undefined,
  effort: string,
  review: boolean,
) {
  if (model === undefined) return { capacity: 1 };
  const lightWorker = { model, effort };
  return {
    capacity: 2,
    lightWorker: lightRole({ capacity: 2, lightWorker }, review),
  };
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
      "light-worker-model": { type: "string" },
      "light-worker-effort": { type: "string", default: "high" },
      review: { type: "boolean", default: false },
      store: { type: "string" },
      check: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      effective: { type: "boolean", default: false },
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
  const lanes = workerLanes(
    values["light-worker-model"],
    values["light-worker-effort"],
    values.review,
  );
  return { ...values, setup, setupTimeoutMs, lanes };
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

async function excludeGenerated(root: string) {
  const excludePath = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" },
  ).trim();
  const exclude = resolve(root, excludePath);
  await mkdir(resolve(exclude, ".."), { recursive: true });
  const old = await readText(exclude);
  const present = new Set(old.split("\n"));
  const missing = [
    "/.amp/plugins/software-factory.js",
    `/${dashboardDir}/`,
  ].filter((rule) => !present.has(rule));
  if (missing.length === 0) return;
  const gap = old === "" || old.endsWith("\n") ? "" : "\n";
  await appendFile(exclude, `${gap}${missing.join("\n")}\n`);
}

async function definitionOperation(
  root: string,
  values: ReturnType<typeof options>,
) {
  if (
    [values.check, values.refresh, values.migrate, values.effective].filter(
      Boolean,
    ).length > 1
  )
    throw new Error(
      "Choose only one of --check, --refresh, --migrate, --effective",
    );
  if (values.migrate) {
    await migrateDefinition(root);
    process.stdout.write("MIGRATION OK; definition is factory/config/\n");
    return true;
  }
  if (values.effective) {
    process.stdout.write(
      JSON.stringify(await effectiveDefinition(root)) + "\n",
    );
    return true;
  }
  return false;
}

async function main() {
  const values = options();
  const workerEffort = parseWorkerEffort(values["worker-effort"]);
  const root = repository(values.repo);
  const configPath = join(root, ".factory.json");
  const pluginPath = join(root, ".amp/plugins/software-factory.js");
  const refresh = values.refresh;
  if (await existingSetup(root, pluginPath, values)) return;
  if (!refresh) await initialInputs(root, values);
  const store = resolveStore(values.store);
  const services = await servicesAppend(root);
  const plugin = await bundlePlugin(root, store);
  const dashboard = await bundleDashboard();
  await mkdir(join(root, ".amp/plugins"), { recursive: true });
  if (refresh) {
    await refreshPlugin(pluginPath, plugin);
    await installDashboard(root, dashboard);
    await installServices(root, services);
    await excludeGenerated(root);
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
    ...values.lanes,
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
    await installDashboard(root, dashboard);
    await installServices(root, services);
    await excludeGenerated(root);
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
