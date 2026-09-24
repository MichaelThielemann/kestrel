import { renameContentField } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { Rule } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { finding, moduleEntry } from "./ruleHelpers.ts";

const RULE_ID = "model/underscore-field";

function questionId(typeName: string, field: string): string {
  return `underscore-field:${typeName}.${field}`;
}

function fieldNames(config: unknown, typeName: string): string[] {
  if (!isRecord(config)) return [];
  const types = config.types;
  if (!isRecord(types)) return [];
  const type = types[typeName];
  if (!isRecord(type) || !isRecord(type.fields)) return [];
  return Object.keys(type.fields);
}

function typeNames(config: unknown): string[] {
  if (!isRecord(config) || !isRecord(config.types)) return [];
  return Object.keys(config.types);
}

function storedCounts(ctx: { project: { data?: Record<string, unknown> } }, typeName: string, field: string): Record<string, number | null> | undefined {
  const underscoreFields = ctx.project.data?.underscoreFields;
  if (!isRecord(underscoreFields)) return undefined;
  const counts = underscoreFields[`${typeName}.${field}`];
  if (!isRecord(counts)) return undefined;
  const out: Record<string, number | null> = {};
  for (const [locale, n] of Object.entries(counts)) if (typeof n === "number" || n === null) out[locale] = n;
  return out;
}

function describeCounts(counts: Record<string, number | null>): string {
  return Object.entries(counts)
    .map(([locale, n]) => {
      if (n === null) return locale === "unlocalized" ? "not counted" : `not counted in "${locale}"`;
      return locale === "unlocalized" ? `${n} stored value(s)` : `${n} in "${locale}"`;
    })
    .join(", ");
}

/** A content model field starting with `_` fails boot in 6.0.0; content migrations run through `content@1`, so a stored value must move before the model drops the old key. */
export const underscoreFieldRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const entry = moduleEntry(ctx, "content-default");
    if (entry === undefined) return [];
    const findings: Finding[] = [];
    for (const typeName of typeNames(entry.config)) {
      const declaredFields = fieldNames(entry.config, typeName);
      for (const field of declaredFields) {
        if (!field.startsWith("_")) {
          const orphanField = `_${field}`;
          if (declaredFields.includes(orphanField)) continue;
          const orphanCounts = storedCounts(ctx, typeName, orphanField);
          if (orphanCounts === undefined || Object.values(orphanCounts).every((n) => n === 0)) continue;
          findings.push({
            id: `${RULE_ID}:${typeName}.${orphanField}`,
            rule: RULE_ID,
            severity: "warning",
            tier: "source",
            where: { module: entry.use, path: `types.${typeName}.fields.${field}` },
            message: `the old column "${orphanField}" on content type "${typeName}" still has stored data (${describeCounts(orphanCounts)}); the current field is named "${field}"`,
            suggestion: `add a migration on the running 5.8.x instance (defineMigration) copying "${orphanField}" to "${field}", then run \`kestrel-upgrade data\` again to confirm "${orphanField}" is empty`,
            fix: { kind: "none" },
            docs: "docs/upgrading.md#model-underscore-field",
          });
          continue;
        }
        const id = `${RULE_ID}:${typeName}.${field}`;
        const where = { module: entry.use, path: `types.${typeName}.fields.${field}` };
        const counts = storedCounts(ctx, typeName, field);
        const verifiedEmpty = counts !== undefined && Object.values(counts).every((n) => n === 0);
        const hasStoredData = counts !== undefined && Object.values(counts).some((n) => n !== null && n > 0);
        const defaultName = field.replace(/^_+/, "");
        const answer = ctx.answers.get(questionId(typeName, field));
        const target = answer === "remove" ? undefined : (answer ?? (verifiedEmpty ? defaultName : undefined));

        if (verifiedEmpty && target !== undefined) {
          const source = ctx.readFile(ctx.project.configFile);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = renameContentField(ctx.project.configFile, source, { use: entry.use, typeName, from: field, to: target });
            if (edit) edits.push(edit);
          }
          findings.push(finding(id, RULE_ID, `"${field}" on content type "${typeName}" starts with "_"; a data report counted zero stored values (${describeCounts(counts)})`, `rename to "${target}"`, where, edits, "docs/upgrading.md#model-underscore-field"));
          continue;
        }
        if (answer !== undefined && answer !== "remove") {
          const source = ctx.readFile(ctx.project.configFile);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = renameContentField(ctx.project.configFile, source, { use: entry.use, typeName, from: field, to: answer });
            if (edit) edits.push(edit);
          }
          const proof = counts === undefined ? "no data report was supplied" : `a data report counted stored values (${describeCounts(counts)})`;
          findings.push(
            finding(
              id,
              RULE_ID,
              `"${field}" on content type "${typeName}" starts with "_"`,
              `renamed to "${answer}" — ${proof}, not a proving zero count; the old column "${field}" on "${typeName}" may still hold data. Add a migration on the running 5.8.x instance before it upgrades, then run \`kestrel-upgrade data --db <file> --out <report>.json\` and check again with --data-report <report>.json to clear this warning`,
              where,
              edits,
              "docs/upgrading.md#model-underscore-field",
              "warning",
            ),
          );
          continue;
        }

        const fix: AskFix = {
          kind: "ask",
          question: questionId(typeName, field),
          prompt: counts === undefined ? `rename "${field}" on "${typeName}" to (no data report supplied; run \`kestrel-upgrade data\` first, or see docs/upgrading.md#model-underscore-field)` : `rename "${field}" on "${typeName}" to`,
          choices: [defaultName, "remove"],
        };
        findings.push({
          id,
          rule: RULE_ID,
          severity: "error",
          tier: "source",
          where,
          message: hasStoredData
            ? `"${field}" on content type "${typeName}" starts with "_", which fails boot on 6.0.0; a data report counted stored values (${describeCounts(counts)})`
            : `"${field}" on content type "${typeName}" starts with "_", which fails boot on 6.0.0`,
          suggestion:
            counts === undefined
              ? "run `kestrel-upgrade data --db <file> --out <report>.json` against a copy of the store, then check again with --data-report <report>.json — see docs/upgrading.md#model-underscore-field"
              : "a stored value exists in at least one locale; add a migration on the running 5.8.x instance (defineMigration) copying it to the new key before upgrading",
          fix,
          docs: "docs/upgrading.md#model-underscore-field",
        });
      }
    }
    return findings;
  },
  applyAnswer(id, value, ctx) {
    if (!id.startsWith("underscore-field:") || value === "remove") return undefined;
    const rest = id.slice("underscore-field:".length);
    const dot = rest.lastIndexOf(".");
    if (dot === -1) return undefined;
    const typeName = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    const entry = moduleEntry(ctx, "content-default");
    const source = entry === undefined ? undefined : ctx.readFile(ctx.project.configFile);
    if (entry === undefined || source === undefined) return undefined;
    const edit = renameContentField(ctx.project.configFile, source, { use: entry.use, typeName, from: field, to: value });
    return edit ? [edit] : undefined;
  },
};

export const underscoreFieldRules: readonly Rule[] = [underscoreFieldRule];
