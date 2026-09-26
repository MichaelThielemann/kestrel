import { resolve } from "node:path";
import { loadHostPlugins, refusalMessage, scanHosts, selectHostPlugin } from "@michaelthielemann/kestrel-upgrade/hosts";
import { parseArgs, PLUGIN_API_VERSION, runUpgradeCli, stringFlag } from "@michaelthielemann/kestrel-upgrade/plugin";
import { cliVersion } from "../usage.ts";

const NO_HOSTS = { loadable: [], outdated: [], refused: [] };

/** `kestrel upgrade`: discovers the host plugin and runs the upgrade engine with the rest of argv unchanged. */
export async function run(argv: readonly string[]): Promise<number> {
  const noPlugins = argv.includes("--no-plugins");
  const rest = argv.filter((arg) => arg !== "--no-plugins");
  if (noPlugins) return runUpgradeCli(rest, { plugins: [], hosts: NO_HOSTS });
  const root = resolve(stringFlag(parseArgs(rest.slice(1)), "root") ?? ".");
  const version = cliVersion();
  const hosts = scanHosts(root, { cliVersion: version });
  if (hosts.refused.length > 0) {
    process.stderr.write(`kestrel upgrade: ${hosts.refused.map(refusalMessage).join("\n")}\n`);
    return 2;
  }
  const { loaded, refused } = await loadHostPlugins(hosts.loadable, { pluginApiVersion: PLUGIN_API_VERSION, cliVersion: version });
  if (refused.length > 0) {
    process.stderr.write(`kestrel upgrade: ${refused.map(refusalMessage).join("\n")}\n`);
    return 2;
  }
  const selection = await selectHostPlugin(loaded, root);
  if (!selection.ok) {
    process.stderr.write(`kestrel upgrade: ${selection.message}\n`);
    return 2;
  }
  return runUpgradeCli(rest, { plugins: selection.active === undefined ? [] : [selection.active.plugin], hosts });
}
