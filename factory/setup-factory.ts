#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
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
import { configuration, localPath, parseWorkerEffort } from "./native";

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: "." },
      prd: { type: "string" },
      verify: { type: "string" },
      scope: { type: "string", multiple: true },
      "worker-model": { type: "string", default: "openai/gpt-6.1-sol" },
      "worker-effort": { type: "string", default: "medium" },
      store: { type: "string" },
      check: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
    },
  });
  const workerEffort = parseWorkerEffort(values["worker-effort"]);
  const root = resolve(values.repo);
  const top = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  if (root !== top) throw new Error("--repo must name the Git repository root");
  execFileSync("amp", ["--version"], { stdio: "pipe" });
  const configPath = join(root, ".factory.json");
  const pluginPath = join(root, ".amp/plugins/software-factory.js");
  if (values.check && values.refresh)
    throw new Error("--check cannot be combined with --refresh");
  if (values.check) {
    await configuration(root);
    if (!existsSync(pluginPath))
      throw new Error("Factory plugin is not installed");
    process.stdout.write(
      "SETUP OK (execution remains separately controlled)\n",
    );
    return;
  }
  const refresh = values.refresh;
  if (refresh && !existsSync(configPath))
    throw new Error("Cannot refresh before factory setup");
  if (existsSync(configPath) && !refresh) {
    await configuration(root);
    if (!existsSync(pluginPath))
      throw new Error(
        "Existing configuration has no plugin; restore it before rerunning setup",
      );
    process.stdout.write("SETUP UNCHANGED\n");
    return;
  }
  if (!refresh && (!values.prd || !values.verify || !values.scope?.length))
    throw new Error("Provide --prd, --verify, and --scope");
  if (refresh) {
    await configuration(root);
  } else {
    await readFile(localPath(root, values.prd!), "utf8");
    for (const path of values.scope!) localPath(root, path);
  }
  const skill = values.store
    ? null
    : execFileSync("amp", ["skill", "info", "poteto-mode"], {
        encoding: "utf8",
      });
  const uri = skill?.match(/^Path: (file:\/\/\S+)$/m)?.[1];
  const store = values.store
    ? resolve(values.store)
    : uri
      ? join(fileURLToPath(uri), "scripts/orch/store.ts")
      : "";
  if (!store || !existsSync(store))
    throw new Error(
      "Install poteto-mode or pass --store /path/to/orch/store.ts",
    );
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
    const plugin = await result.outputs[0].text();
    const config = refresh
      ? null
      : {
          version: 1,
          prd: values.prd,
          tickets: ".factory-tickets.json",
          verify: values.verify,
          scope: values.scope,
          capacity: 1,
          mode: "bug-finding",
          workerModel: values["worker-model"],
          workerEffort,
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
    await mkdir(join(root, ".amp/plugins"), { recursive: true });
    if (refresh) {
      const temporary = `${pluginPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, plugin, { flag: "wx" });
        await rename(temporary, pluginPath);
      } finally {
        await rm(temporary, { force: true });
      }
      process.stdout.write("REFRESH OK; reload the factory plugin.\n");
    } else {
      const tickets = join(root, config!.tickets);
      if (existsSync(pluginPath) || existsSync(tickets))
        throw new Error(
          "Setup refuses to overwrite existing plugin or ticket files",
        );
      await writeFile(pluginPath, plugin, { flag: "wx" });
      await writeFile(tickets, "[]\n", { flag: "wx" });
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
        flag: "wx",
      });
      const excludePath = execFileSync(
        "git",
        ["-C", root, "rev-parse", "--git-path", "info/exclude"],
        { encoding: "utf8" },
      ).trim();
      const exclude = resolve(root, excludePath);
      await mkdir(resolve(exclude, ".."), { recursive: true });
      const old = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
      await writeFile(exclude, old + "\n/.amp/plugins/software-factory.js\n");
      process.stdout.write(
        "SETUP OK; execution disabled. Review .factory.json and .factory-tickets.json.\n",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
