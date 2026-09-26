import { resolve } from "node:path";
import { loadHostPlugins, refusalMessage, scanHosts, selectHostPlugin } from "@michaelthielemann/kestrel-upgrade/hosts";
import { parseArgs, PLUGIN_API_VERSION, runUpgradeCli, stringFlag } from "@michaelthielemann/kestrel-upgrade/plugin";
import { cliVersion } from "../usage.ts";

async function inDirectory<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await body();
  } finally {
    process.chdir(previous);
  }
}

/** `kestrel upgrade`: discovers the host plugin, with the project root as the cwd while its code runs, and runs the upgrade engine with the rest of argv unchanged. `--no-plugins` loads no plugin but keeps the outdated and refused host findings. */
export async function run(argv: readonly string[]): Promise<number> {
  const noPlugins = argv.includes("--no-plugins");
  const rest = argv.filter((arg) => arg !== "--no-plugins");
  const root = resolve(stringFlag(parseArgs(rest.slice(1)), "root") ?? ".");
  const version = cliVersion();
  const hosts = scanHosts(root, { cliVersion: version });
  if (noPlugins) return runUpgradeCli(rest, { plugins: [], hosts: { loadable: [], outdated: hosts.outdated, refused: hosts.refused } });
  if (hosts.refused.length > 0) {
    process.stderr.write(`kestrel upgrade: ${hosts.refused.map(refusalMessage).join("\n")}\n`);
    return 2;
  }
  const selection = await inDirectory(root, async () => {
    const { loaded, refused } = await loadHostPlugins(hosts.loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: version });
    if (refused.length > 0) return { ok: false as const, message: refused.map(refusalMessage).join("\n") };
    return selectHostPlugin(loaded, root);
  });
  if (!selection.ok) {
    process.stderr.write(`kestrel upgrade: ${selection.message}\n`);
    return 2;
  }
  return runUpgradeCli(rest, { plugins: selection.active === undefined ? [] : [selection.active.plugin], hosts });
}
