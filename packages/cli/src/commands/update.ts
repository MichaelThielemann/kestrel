import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHostPlugins, refusalMessage, scanHosts, selectHostPlugin } from "@michaelthielemann/kestrel-upgrade/hosts";
import { PLUGIN_API_VERSION, type OpsFacts } from "@michaelthielemann/kestrel-upgrade/plugin";
import { OPS_PACKAGE, runOpsCommand } from "../ops.ts";
import { cliVersion, COMMAND_USAGE } from "../usage.ts";

type HostFacts = Pick<OpsFacts, "readyPath" | "localBootEnv" | "exportChecks" | "secretEnvNames" | "migrationSwitches">;
type UpdateRunner = (argv: readonly string[], options: { host: HostFacts }) => Promise<number>;

const isRunner = (value: unknown): value is UpdateRunner => typeof value === "function";

async function inDirectory<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await body();
  } finally {
    process.chdir(previous);
  }
}

async function hostFacts(root: string): Promise<{ ok: true; facts: HostFacts } | { ok: false; message: string }> {
  const version = cliVersion();
  const hosts = scanHosts(root, { cliVersion: version });
  if (hosts.refused.length > 0) return { ok: false, message: hosts.refused.map(refusalMessage).join("\n") };
  return inDirectory(root, async () => {
    const { loaded, refused } = await loadHostPlugins(hosts.loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: version });
    if (refused.length > 0) return { ok: false as const, message: refused.map(refusalMessage).join("\n") };
    const selection = await selectHostPlugin(loaded, root);
    if (!selection.ok) return selection;
    const facts = (await selection.active?.plugin.ops?.(root)) ?? {};
    const { readyPath, localBootEnv, exportChecks, secretEnvNames, migrationSwitches } = facts;
    return { ok: true as const, facts: { ...(readyPath === undefined ? {} : { readyPath }), ...(localBootEnv === undefined ? {} : { localBootEnv }), ...(exportChecks === undefined ? {} : { exportChecks }), ...(secretEnvNames === undefined ? {} : { secretEnvNames }), ...(migrationSwitches === undefined ? {} : { migrationSwitches }) } };
  });
}

async function projectRunUpdate(root: string): Promise<UpdateRunner | null> {
  for (const base of [join(root, "package.json"), import.meta.url]) {
    let file: string;
    try {
      file = createRequire(base).resolve(`${OPS_PACKAGE}/run`);
    } catch {
      continue;
    }
    const runUpdate: unknown = Reflect.get(Object(await import(pathToFileURL(file).href)), "runUpdate");
    return isRunner(runUpdate) ? runUpdate : null;
  }
  return null;
}

/**
 * `kestrel update`: the update assistant of the installed kestrel-ops. `--help` lists the seven commands an operator
 * runs. `prepare` and `bundle` hand the facts the project's host plugin contributes (its readiness path, secret
 * variable names, migration switches, export checks, local start variables) to kestrel-ops; exit 2 when kestrel-ops
 * is missing or has no update assistant.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const [sub] = argv;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(`${COMMAND_USAGE.update}\n`);
    return 0;
  }
  if (sub !== "prepare" && sub !== "bundle") return runOpsCommand("update", argv);
  const root = process.cwd();
  const runUpdate = await projectRunUpdate(root);
  if (runUpdate === null) return runOpsCommand("update", argv);
  const facts = await hostFacts(root);
  if (!facts.ok) {
    process.stderr.write(`kestrel update: ${facts.message}\n`);
    return 2;
  }
  return runUpdate(argv, { host: facts.facts });
}
