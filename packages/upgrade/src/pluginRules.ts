import type { LoadIssue, Rule, UpgradePlugin } from "./plugin.ts";
import type { Finding } from "./report.ts";

export function overrideConflicts(plugins: readonly UpgradePlugin[]): LoadIssue[] {
  const owners = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const plugin of plugins) {
    for (const id of Object.keys(plugin.overrides ?? {})) {
      const owner = owners.get(id);
      if (owner !== undefined && owner !== plugin.kind) conflicts.add(id);
      else owners.set(id, plugin.kind);
    }
  }
  return [...conflicts].sort().map((id) => ({ message: `rule "${id}" is overridden by more than one registered plugin` }));
}

export function mergeRules(defaultRules: readonly Rule[], plugin: UpgradePlugin | undefined): { rules: Rule[]; notices: Finding[] } {
  const kind = plugin?.kind ?? "";
  const overrides = new Map(Object.entries(plugin?.overrides ?? {}));
  const notices: Finding[] = [];
  const rules: Rule[] = [];
  for (const rule of defaultRules) {
    if (!overrides.has(rule.id)) {
      rules.push(rule);
      continue;
    }
    const replacement = overrides.get(rule.id);
    overrides.delete(rule.id);
    if (replacement === null || replacement === undefined) {
      notices.push({
        id: `plugin/rule-disabled:${rule.id}`,
        rule: "plugin/rule-disabled",
        severity: "info",
        tier: "source",
        where: {},
        message: `rule "${rule.id}" disabled by plugin "${kind}"`,
        suggestion: "see the plugin's own documentation for what replaces this check, if anything",
        fix: { kind: "none" },
        docs: "docs/upgrading.md#plugin-api",
      });
      continue;
    }
    rules.push(replacement);
    notices.push({
      id: `plugin/rule-replaced:${rule.id}`,
      rule: "plugin/rule-replaced",
      severity: "info",
      tier: "source",
      where: {},
      message: `rule "${rule.id}" replaced by plugin "${kind}"`,
      suggestion: "see the plugin's own documentation for the replacement's behaviour",
      fix: { kind: "none" },
      docs: "docs/upgrading.md#plugin-api",
    });
  }
  for (const replacement of overrides.values()) {
    if (replacement !== null) rules.push(replacement);
  }
  return { rules: [...rules, ...(plugin?.rules ?? [])], notices };
}
