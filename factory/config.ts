import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import configSchema from "./config.schema.json";
import { validCron } from "./cron";
import definitionSchema from "./definition.schema.json";

/** The repository-relative directory that holds one file per agent, runner and the shared settings. */
export const configDirectory = "factory/config";

type Files = Map<string, Buffer>;
type Data = Record<string, unknown>;
const hookSchema = definitionSchema.properties.hooks;
const hookInput = hookSchema.items.properties;
const hookName = new RegExp(hookInput.name.pattern);

/** One fixed local effect for a supported Amp event, with no shell or path input. */
export type NativeHook = {
  event: "agent.start";
  action: "create-marker";
  name: string;
  timeoutMs: number;
};

function validHookTimeout(value: unknown) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= hookInput.timeoutMs.minimum &&
    value <= hookInput.timeoutMs.maximum
  );
}

function validHookName(value: unknown) {
  return typeof value === "string" && hookName.exec(value)?.[0] === value;
}

/** Validate the same declaration for authored definitions and stored pins. */
export function validNativeHooks(
  value: unknown,
): value is NativeHook[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > hookSchema.maxItems) return false;
  return value.every((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const hook = item as Data;
    return (
      Object.keys(hook).every((key) => Object.hasOwn(hookInput, key)) &&
      hook.event === hookInput.event.const &&
      hook.action === hookInput.action.const &&
      validHookName(hook.name) &&
      validHookTimeout(hook.timeoutMs)
    );
  });
}

/** Validate the optional hook field before pinning it. @throws On invalid declarations. */
export function parseNativeHooks(value: unknown) {
  if (validNativeHooks(value)) return value;
  throw new Error(
    "Invalid hooks: expected at most one bounded agent.start create-marker declaration",
  );
}

export type VerificationCapability = {
  /** External executable, resolved in the same login shell as the check. */
  tool: string;
  /** Arguments for a read-only version probe, not the verification command. */
  versionArgs: string[];
  /** Authored scope of the check, not measured code coverage. */
  coverage: string[];
};

/** One gate check from `checks/<name>.yaml`; a definition holds them in run order. */
export type Check = {
  name: string;
  command: string;
  /** False makes the check advisory: its failure is reported but never rejects. */
  required: boolean;
  timeoutMs: number;
  /** Optional installed-tool contract; absence preserves the ordinary shell check. */
  capability?: VerificationCapability;
};
/** The timeout of a check that sets none, and of the flat `verify` command. */
export const defaultCheckTimeoutMs = 600_000;

/** One authored automation: a prompt the Foreman thread receives on a UTC cron schedule. */
export type Automation = {
  name: string;
  schedule: string;
  enabled: boolean;
  prompt: string;
};

/** Opt-in fast landing command and UTC cron for the ordinary full gate. */
export type ScheduledGatePolicy = { landing: string; schedule: string };

/** Check the same policy at the authored definition and persisted pin boundaries. */
export function validScheduledGatePolicy(
  value: unknown,
): value is ScheduledGatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { landing, schedule } = value as Data;
  return (
    Object.keys(value).length === 2 &&
    typeof landing === "string" &&
    /\S/.test(landing) &&
    !landing.includes("\0") &&
    typeof schedule === "string" &&
    validCron(schedule)
  );
}

const schemas: Record<string, { properties: object; required?: string[] }> =
  configSchema.$defs;
const runnerTemplate = "runners/<name>.yaml";
const checkTemplate = "checks/<name>.yaml";
const automationTemplate = "automations/<name>/automation.md";
// Any first non-blank line starting with `---` claims front matter; only the strict form parses
// (either line ending, optional BOM, trailing spaces), so a near miss is refused, not read as bare.
const opensFrontMatter = /^\uFEFF?\s*---/;
const frontMatter =
  /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const runnerName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const runnerFile = /^runners\/([A-Za-z0-9][A-Za-z0-9._-]*)\.yaml$/;
const checkPath = /^checks\/([A-Za-z0-9][A-Za-z0-9._-]*)\.yaml$/;
const automationDirectory = /^automations\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const automationFile =
  /^automations\/([A-Za-z0-9][A-Za-z0-9._-]*)\/automation\.md$/;
const foreman = "agents/foreman/agent.md";
const implementer = "agents/implementer/agent.md";
const light = "agents/light-implementer/agent.md";
const reviewer = "agents/reviewer/agent.md";
const observer = "agents/observer/agent.md";
// The executor with no runner ID; its setup lives in runners/local.yaml.
const localRunner = "local";
// Scratch for migration, beside the directory so a link stays on one filesystem.
const scratchPrefix = ".config-migrating";

// Every directory the layout allows, derived from its files: agents, each agent, runners and
// automations; a template's <name> part is matched by pattern, never listed.
const layoutDirectories = new Set(
  Object.keys(schemas).flatMap((path) => {
    const parts = path
      .split("/")
      .slice(0, -1)
      .filter((part) => !part.includes("<"));
    return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  }),
);

/** Validate authored and persisted capability declarations, including unknown keys. */
export function validVerificationCapability(
  value: unknown,
): value is VerificationCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Data;
  const nonblank = (item: unknown): item is string =>
    typeof item === "string" && /\S/.test(item) && !item.includes("\0");
  return (
    Object.keys(data).every((key) =>
      ["tool", "versionArgs", "coverage"].includes(key),
    ) &&
    nonblank(data.tool) &&
    Array.isArray(data.versionArgs) &&
    data.versionArgs.length > 0 &&
    data.versionArgs.every(nonblank) &&
    Array.isArray(data.coverage) &&
    data.coverage.length > 0 &&
    data.coverage.every(nonblank)
  );
}

// A directory the layout allows: a fixed one, or one automation's own.
function inLayout(directory: string) {
  return (
    layoutDirectories.has(directory) || automationDirectory.test(directory)
  );
}

function requireAutomationFile(directory: string, files: Files) {
  if (
    automationDirectory.test(directory) &&
    !files.has(`${directory}/automation.md`)
  )
    fail(directory, "has no automation.md");
}

// The one place a path becomes its schema; the template key itself is never a file.
function schemaFor(path: string) {
  if (runnerFile.test(path)) return schemas[runnerTemplate];
  if (checkPath.test(path)) return schemas[checkTemplate];
  if (automationFile.test(path)) return schemas[automationTemplate];
  return ![runnerTemplate, checkTemplate, automationTemplate].includes(path) &&
    Object.hasOwn(schemas, path)
    ? schemas[path]
    : undefined;
}

// Every path into this module refuses with the file's name.
function fail(path: string, message: string): never {
  throw new Error(`${configDirectory}/${path}: ${message}`);
}

function defined(data: Data): Data {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

function yamlText(data: Data) {
  return `${Bun.YAML.stringify(data, null, 2)}\n`;
}

function markdown(data: Data, body = "") {
  return `---\n${Object.keys(data).length ? yamlText(data) : ""}---\n${body}`;
}

function parseYaml(path: string, source: string): Data {
  let value: unknown;
  try {
    value = Bun.YAML.parse(source);
  } catch {
    fail(path, "is not valid YAML");
  }
  value ??= {};
  if (typeof value !== "object" || Array.isArray(value))
    fail(path, "expected a mapping of settings");
  return value as Data;
}

// The one classification of a Markdown file: bare (no settings) or front matter plus body.
// A file that claims front matter but does not parse is refused, never read as a bare body.
function splitMarkdown(path: string, raw: string) {
  if (!opensFrontMatter.test(raw)) return { bare: true, yaml: "", body: raw };
  const match = frontMatter.exec(raw);
  if (!match)
    fail(
      path,
      "has malformed front matter; open and close it with a --- line at the top",
    );
  return { bare: false, yaml: match[1] ?? "", body: match[2]! };
}

// Markdown carries its settings in front matter; any other file is all settings.
function parseFile(path: string, bytes: Buffer) {
  const raw = bytes.toString("utf8");
  if (!path.endsWith(".md")) return { data: parseYaml(path, raw), body: "" };
  const { yaml, body } = splitMarkdown(path, raw);
  return { data: parseYaml(path, yaml), body };
}

/** Whether a repository-relative path is the config directory or inside it, which workers may not edit. */
export function isConfigPath(path: string) {
  return path === configDirectory || path.startsWith(`${configDirectory}/`);
}

/** Whether `factory/config/` exists.
 * @param forWrite Also check `factory` when the config root is absent, so a write never follows a
 * link there. Reads leave a flat-only project with a linked `factory` loading as before.
 * @throws When the config root, or `factory` above it, is a link or not a directory: a link can
 * alias a path a worker may edit, or reach outside the repository.
 */
export function configRootExists(root: string, forWrite = false) {
  const stat = (path: string) => {
    try {
      return lstatSync(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const present = stat(configDirectory) !== undefined;
  if (present || forWrite)
    for (const path of [configDirectory, "factory"]) {
      const found = stat(path);
      if (found && !found.isDirectory())
        throw new Error(`${path} must be a real directory, not a link or file`);
    }
  return present;
}

/** Refuse a config directory without `factory.yaml` that holds anything but the bundled Foreman
 * prompt as a bare body, so an invalid, configured or half-written directory beside a flat
 * definition is never ignored.
 * @throws With the unexpected path, or on a linked config root.
 */
export async function refuseUnfinishedConfig(root: string) {
  if (!configRootExists(root)) return;
  for (const [path, bytes] of await readConfigFiles(root))
    if (path !== foreman || !splitMarkdown(path, bytes.toString("utf8")).bare)
      fail(
        path,
        "is not allowed beside a flat definition without factory.yaml; finish explicit --migrate or remove it",
      );
  // An empty automations/ yields no file above, so its presence is refused here.
  if (existsSync(join(root, configDirectory, "automations")))
    fail(
      "automations",
      "is not allowed beside a flat definition without factory.yaml; finish explicit --migrate or remove it",
    );
}

/** Whether `factory/config/factory.yaml` exists, which is what makes the directory the definition. @throws On a linked config root. */
export function hasConfigDefinition(root: string) {
  return (
    configRootExists(root) &&
    existsSync(join(root, configDirectory, "factory.yaml"))
  );
}

/** Read every file under `factory/config/` in sorted path order, refusing links, special files and
 * directories outside the layout even when empty.
 * @throws On a non-regular entry, an unsupported directory or a linked config root.
 */
export async function readConfigFiles(root: string): Promise<Files> {
  configRootExists(root);
  const files: Files = new Map();
  const walk = async (directory: string) => {
    if (directory && !inLayout(directory))
      fail(directory, "is not part of the config layout");
    const entries = await readdir(join(root, configDirectory, directory), {
      withFileTypes: true,
    });
    // An empty checks/ would leave a gate that runs nothing; refuse it on every path.
    if (directory === "checks" && !entries.length)
      fail(directory, "is empty; add a required check or remove it");
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files.set(path, await readFile(join(root, configDirectory, path)));
      else fail(path, "must be a regular file");
    }
    requireAutomationFile(directory, files);
  };
  await walk("");
  return files;
}

/** Hash every config file in sorted path order, each with its path and length, then the instructions. */
export function digestConfigFiles(files: Files, instructions: string) {
  const hash = createHash("sha256");
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1)))
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  return hash.update("\0").update(instructions).digest("hex");
}

function checkFile(path: string, file: ReturnType<typeof parseFile>) {
  const schema = schemaFor(path)!;
  for (const key of Object.keys(file.data))
    if (!Object.hasOwn(schema.properties, key))
      fail(path, `unsupported setting ${key}`);
  for (const key of schema.required ?? [])
    if (file.data[key] === undefined) fail(path, `${key} is required`);
  if (path.startsWith("agents/") && path !== foreman && file.body.trim())
    fail(path, "instructions are not read yet; leave the body empty");
}

/** The automations the directory declares, in path order, with their values checked.
 * Every automation file is validated here, so a file that reload would skip or misread is refused
 * by name. Run after `composeDefinition`, which refuses unknown settings and a missing schedule.
 * @throws With the offending file's path on a bad schedule, a non-boolean `enabled` or an empty body.
 */
export function automationsOf(files: Files): Automation[] {
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
  return sorted.flatMap(([path, bytes]) => {
    const name = automationFile.exec(path)?.[1];
    if (name === undefined) return [];
    const { data, body } = parseFile(path, bytes);
    const { schedule, enabled = false } = data;
    if (typeof schedule !== "string" || !validCron(schedule))
      fail(
        path,
        "schedule must be a quoted 5-field cron expression in UTC that some date satisfies",
      );
    if (typeof enabled !== "boolean")
      fail(path, "enabled must be true or false");
    if (!body.trim()) fail(path, "the prompt after the front matter is empty");
    return [{ name, schedule: schedule.trim(), enabled, prompt: body.trim() }];
  });
}

function runnerId(named: unknown) {
  if (named === undefined) return localRunner;
  if (typeof named !== "string" || !runnerName.test(named))
    fail(implementer, "runner must be a runner ID such as factory-dogfood");
  if (named === localRunner)
    fail(
      implementer,
      `runner ${localRunner} is reserved; omit runner for the local executor`,
    );
  return named;
}

// The cross-reference: the implementer's runner and the runner files must name each other.
function checkRunner(files: Files, named: unknown) {
  const runner = runnerId(named);
  for (const path of files.keys()) {
    const name = runnerFile.exec(path)?.[1];
    if (name !== undefined && name !== runner)
      fail(path, "no agent names this runner");
  }
  if (runner !== localRunner && !files.has(`runners/${runner}.yaml`))
    fail(
      implementer,
      `names runner ${runner} but runners/${runner}.yaml is missing`,
    );
  return runner;
}

function capabilityFields(
  path: string,
  value: unknown,
): Pick<Check, "capability"> {
  if (value === undefined) return {};
  if (!validVerificationCapability(value))
    fail(
      path,
      "invalid capability; expected only tool, versionArgs and coverage with nonblank strings",
    );
  return { capability: value };
}

// The one reader of check values. Files run by `order`, then by name, so ties are deterministic;
// a set of only advisory checks is refused because that gate could never fail.
function composeChecks(parsed: Map<string, { data: Data }>) {
  const checks = [...parsed].flatMap(([path, { data }]) => {
    const name = checkPath.exec(path)?.[1];
    if (name === undefined) return [];
    const { command, order } = data;
    const { required = true, timeoutMs = defaultCheckTimeoutMs } = data;
    if (typeof command !== "string" || !command.trim())
      fail(path, "command must be a non-empty string");
    if (typeof required !== "boolean")
      fail(path, "required must be true or false");
    for (const [key, value] of Object.entries({ timeoutMs, order }))
      if (!Number.isSafeInteger(value) || (value as number) < 1)
        fail(path, `${key} must be a positive integer`);
    const check: Check = {
      name,
      command,
      required,
      timeoutMs: timeoutMs as number,
      ...capabilityFields(path, data.capability),
    };
    return [{ order: order as number, check }];
  });
  if (!checks.length) return undefined;
  if (!checks.some(({ check }) => check.required))
    fail("checks", "has no required check; that gate could never fail");
  return checks
    .sort((a, b) => a.order - b.order || (a.check.name < b.check.name ? -1 : 1))
    .map(({ check }) => check);
}

/** Compose the flat settings object from the directory's files, validating layout, keys and references.
 * Value rules stay with the one validator of the flat object, except check values, which have no
 * flat form: `checks` holds the parsed checks in run order when `checks/` exists.
 * @throws With the offending file's path on an unknown file or setting, a missing or dangling
 * reference, an unread body, an invalid check, or `verify` beside `checks/` or missing without it.
 */
export function composeDefinition(files: Files): Data & { checks?: Check[] } {
  for (const path of files.keys())
    if (!schemaFor(path)) fail(path, "is not part of the config layout");
  for (const path of ["factory.yaml", implementer])
    if (!files.has(path)) fail(path, "is required");
  const parsed = new Map<string, ReturnType<typeof parseFile>>();
  for (const [path, bytes] of files) {
    const file = parseFile(path, bytes);
    checkFile(path, file);
    parsed.set(path, file);
  }
  const data = (path: string) => parsed.get(path)?.data;
  const worker = data(implementer)!;
  const runner = checkRunner(files, worker.runner);
  const checks = composeChecks(parsed);
  const settings = data("factory.yaml")!;
  if (checks && settings.verify !== undefined)
    fail("factory.yaml", "verify is not allowed beside checks/; use one");
  if (!checks && settings.verify === undefined)
    fail("factory.yaml", "verify is required unless checks/ holds checks");
  const lightWorker = data(light);
  const observerSettings = data(observer);
  return {
    ...settings,
    ...defined({
      checks,
      orchestratorModel: data(foreman)?.model,
      workerModel: worker.model,
      workerEffort: worker.effort,
      workerRunner: worker.runner,
      review: parsed.has(reviewer) ? true : undefined,
      observer: observerSettings && {
        model: observerSettings.model,
        effort: observerSettings.effort,
      },
      lightWorker: lightWorker && {
        model: lightWorker.model,
        effort: lightWorker.effort,
      },
    }),
    ...data(`runners/${runner}.yaml`),
  };
}

// The inverse of composeDefinition: the files that compose back to `raw`, in install order with
// factory.yaml last, so a directory without it is never read as a definition.
function splitDefinition(raw: Data, foremanBody: string | undefined) {
  const files = new Map<string, string>();
  const runner = (raw.workerRunner as string | undefined) ?? localRunner;
  const settings = defined({
    setup: raw.setup,
    setupTimeoutMs: raw.setupTimeoutMs,
  });
  if (raw.orchestratorModel !== undefined)
    files.set(foreman, markdown({ model: raw.orchestratorModel }, foremanBody));
  else if (foremanBody !== undefined) files.set(foreman, foremanBody);
  files.set(
    implementer,
    markdown(
      defined({
        model: raw.workerModel,
        effort: raw.workerEffort,
        runner: raw.workerRunner,
      }),
    ),
  );
  if (raw.lightWorker !== undefined) {
    const { model, effort } = raw.lightWorker as Data;
    files.set(light, markdown({ model, effort }));
  }
  if (raw.observer !== undefined) {
    const { model, effort } = raw.observer as Data;
    files.set(observer, markdown({ model, effort }));
  }
  if (raw.review === true) files.set(reviewer, markdown({}));
  if (raw.workerRunner !== undefined || Object.keys(settings).length)
    files.set(`runners/${runner}.yaml`, yamlText(settings));
  const keys = Object.keys(schemas["factory.yaml"]!.properties);
  files.set(
    "factory.yaml",
    yamlText(defined(Object.fromEntries(keys.map((key) => [key, raw[key]])))),
  );
  return files;
}

function readIfPresent(path: string) {
  return existsSync(path) ? readFile(path, "utf8") : undefined;
}

// The files migration would write, after proving they compose back to the definition it started from.
function plannedFiles(raw: Data, current: string | undefined) {
  const planned = splitDefinition(
    raw,
    current === undefined ? undefined : splitMarkdown(foreman, current).body,
  );
  const composed = composeDefinition(
    new Map([...planned].map(([path, text]) => [path, Buffer.from(text)])),
  );
  const expected = defined({
    ...raw,
    review: raw.review === true ? true : undefined,
  });
  if (!isDeepStrictEqual(composed, expected))
    throw new Error(
      "Migration would change the definition's settings; refusing",
    );
  return { planned, expected };
}

// The files still to write; refuses every file that would be overwritten or is not planned.
async function pendingFiles(root: string, planned: Map<string, string>) {
  const directory = join(root, configDirectory);
  if (existsSync(directory))
    for (const path of (await readConfigFiles(root)).keys())
      if (!planned.has(path))
        fail(
          path,
          "is not part of this definition; migration refuses to keep it",
        );
  const pending: [string, string, boolean][] = [];
  for (const [path, text] of planned) {
    const target = join(directory, path);
    const existing = await readIfPresent(target);
    if (existing === text) continue;
    if (
      existing !== undefined &&
      !(path === foreman && splitMarkdown(path, existing).bare)
    )
      fail(path, "exists and differs; migration refuses to overwrite it");
    pending.push([target, text, existing !== undefined]);
  }
  return pending;
}

/** Write the directory for a validated flat definition, repeatably and without overwriting anyone's edits.
 * Files already holding exactly what migration would write are kept; the one exception is a Foreman
 * prompt with no front matter, which gains the model's front matter and keeps its body.
 * Nothing is written when a file would be overwritten, an unplanned file is present, or the planned
 * files would not compose back to `raw`. factory.yaml lands last, so a partial directory is never a
 * definition, and each file lands atomically. The written directory is composed once more before
 * returning, so the caller never removes its flat source over settings that do not match it.
 * @throws With the offending file's path.
 */
export async function writeConfigFiles(root: string, raw: Data) {
  configRootExists(root, true);
  const current = await readIfPresent(join(root, configDirectory, foreman));
  const { planned, expected } = plannedFiles(raw, current);
  const pending = await pendingFiles(root, planned);
  // Every file gets its own never-reused scratch inode, so an interruption between link and
  // cleanup leaves a stale name that nothing reopens. Stale scratch is only unlinked, never written.
  // ponytail: a concurrent migration's scratch is removed too and that run fails safe; add a lock if it matters.
  const scratch = join(root, "factory");
  await mkdir(scratch, { recursive: true });
  for (const stale of await readdir(scratch))
    if (stale.startsWith(scratchPrefix))
      await rm(join(scratch, stale), { recursive: true, force: true });
  const temporary = await mkdtemp(join(scratch, scratchPrefix));
  for (const [i, [target, text, replace]] of pending.entries()) {
    await mkdir(dirname(target), { recursive: true });
    const staged = join(temporary, String(i));
    await writeFile(staged, text, { flag: "wx" });
    // link refuses a file authored in the meantime; rename replaces only the prompt checked above.
    if (replace) await rename(staged, target);
    else await link(staged, target);
  }
  await rm(temporary, { recursive: true, force: true });
  const written = composeDefinition(await readConfigFiles(root));
  if (!isDeepStrictEqual(written, expected))
    throw new Error(
      `${configDirectory}: written files do not match the definition; refusing to remove it`,
    );
}
