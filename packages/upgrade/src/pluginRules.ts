import type { LoadIssue, Rule, UpgradePlugin } from "./plugin.ts";

export async function detectPlugin(plugins: readonly UpgradePlugin[], root: string): Promise<{ plugin?: UpgradePlugin; issues: LoadIssue[] }> {
  const issues: LoadIssue[] = [];
  for (const plugin of plugins) {
    try {
      if (await plugin.detect(root)) return { plugin, issues };
    } catch (err) {
      issues.push({ message: `plugin "${plugin.kind}" detect() threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { issues };
}

/**
 * Merges a plugin's own `rules` alongside `defaultRules`. A plugin rule id that collides with a
 * built-in one is a load error naming both the id and the plugin, and the merged list excludes that
 * rule — the built-in keeps running under that id, since a plugin needing different behaviour for a
 * built-in rule reaches for a hook (`locateSteps`, `locateModelFields`, `dataModel`, `switchEdits`),
 * never a same-id replacement.
 */
export function mergeRules(defaultRules: readonly Rule[], plugin: UpgradePlugin | undefined): { rules: Rule[]; issues: LoadIssue[] } {
  const builtInIds = new Set(defaultRules.map((r) => r.id));
  const pluginRules = plugin?.rules ?? [];
  const colliding = pluginRules.filter((r) => builtInIds.has(r.id));
  const issues: LoadIssue[] = colliding.map((r) => ({ message: `plugin "${plugin?.kind ?? ""}" registers a rule id "${r.id}" that collides with a built-in rule; rename it` }));
  const collidingIds = new Set(colliding.map((r) => r.id));
  return { rules: [...defaultRules, ...pluginRules.filter((r) => !collidingIds.has(r.id))], issues };
}
