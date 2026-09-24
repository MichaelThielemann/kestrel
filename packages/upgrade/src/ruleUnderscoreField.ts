import { renameContentField } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { Rule } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { finding, moduleEntry } from "./ruleHelpers.ts";

const RULE_ID = "model/underscore-field";

function questionId(typeName: string, field: string): string {
  return `underscore-field:${typeName}.${field}`;
}

function fieldsOf(config: unknown, typeName: string): string[] {
  if (!isRecord(config)) return [];
  const types = config.types;
  if (!isRecord(types)) return [];
  const type = types[typeName];
  if (!isRecord(type) || !isRecord(type.fields)) return [];
  return Object.keys(type.fields).filter((f) => f.startsWith("_"));
}

function typeNames(config: unknown): string[] {
  if (!isRecord(config) || !isRecord(config.types)) return [];
  return Object.keys(config.types);
}

function hasStoredValues(ctx: { project: { data?: Record<string, unknown> } }, typeName: string, field: string): boolean | undefined {
  const report = ctx.project.data;
  if (report === undefined) return undefined;
  const key = `${typeName}.${field}`;
  const value = report[key];
  return typeof value === "boolean" ? value : undefined;
}

/** A content model field starting with `_` fails boot in 6.0.0; content migrations run through `content@1`, so a stored value must move before the model drops the old key. */
export const underscoreFieldRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const entry = moduleEntry(ctx, "content-default");
    if (entry === undefined) return [];
    const findings: Finding[] = [];
    for (const typeName of typeNames(entry.config)) {
      for (const field of fieldsOf(entry.config, typeName)) {
        const id = `${RULE_ID}:${typeName}.${field}`;
        const where = { module: entry.use, path: `types.${typeName}.fields.${field}` };
        const stored = hasStoredValues(ctx, typeName, field);
        const defaultName = field.replace(/^_+/, "");
        const answer = ctx.answers.get(questionId(typeName, field));

        if (stored === false && (answer === undefined || answer === defaultName)) {
          const source = ctx.readFile(ctx.project.configFile);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = renameContentField(ctx.project.configFile, source, { use: entry.use, typeName, from: field, to: defaultName });
            if (edit) edits.push(edit);
          }
          findings.push(finding(id, RULE_ID, `"${field}" on content type "${typeName}" starts with "_"; the data step found no stored value`, `rename to "${defaultName}"`, where, edits, "docs/upgrading.md#model-underscore-field"));
          continue;
        }
        if (answer !== undefined && answer !== "remove") {
          const source = ctx.readFile(ctx.project.configFile);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = renameContentField(ctx.project.configFile, source, { use: entry.use, typeName, from: field, to: answer });
            if (edit) edits.push(edit);
          }
          findings.push(finding(id, RULE_ID, `"${field}" on content type "${typeName}" starts with "_"`, `renamed to "${answer}" — a stored value under the old key still needs a migration on the running 5.8.x instance before it upgrades`, where, edits, "docs/upgrading.md#model-underscore-field"));
          continue;
        }

        const fix: AskFix = {
          kind: "ask",
          question: questionId(typeName, field),
          prompt: stored === undefined ? `rename "${field}" on "${typeName}" to (no data report given; a stored value may still exist)` : `rename "${field}" on "${typeName}" to`,
          choices: [defaultName, "remove"],
          defaultValue: defaultName,
        };
        findings.push({
          id,
          rule: RULE_ID,
          severity: "error",
          tier: "source",
          where,
          message: `"${field}" on content type "${typeName}" starts with "_", which fails boot on 6.0.0`,
          suggestion: stored === undefined ? "run `kestrel-upgrade data --db <copy>` first: a rename is only automatic once it proves no stored value" : "a stored value exists; add a migration on the running 5.8.x instance (defineMigration) copying it to the new key before upgrading",
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
