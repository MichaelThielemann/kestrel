import { renameContentField } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { DataContentModel, Rule } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { finding, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";

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

interface ModelSource {
  use: string;
  config: unknown;
  file: string;
}

function modelSourceOf(contentModel: DataContentModel | undefined, entry: { use: string; config?: unknown } | undefined, defaultFile: string): ModelSource | undefined {
  if (contentModel !== undefined) {
    const config = { types: Object.fromEntries(Object.entries(contentModel.types).map(([typeName, type]) => [typeName, { fields: Object.fromEntries(Object.keys(type.fields).map((field) => [field, {}])) }])) };
    return { use: contentModel.use ?? "", config, file: contentModel.file ?? defaultFile };
  }
  return entry === undefined ? undefined : { use: entry.use, config: entry.config, file: defaultFile };
}

function storedCounts(ctx: { project: { dataReport?: Record<string, unknown> } }, typeName: string, field: string): Record<string, number | null> | undefined {
  const underscoreFields = ctx.project.dataReport?.underscoreFields;
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
    const model = modelSourceOf(ctx.project.contentModel, moduleEntry(ctx, "content-default"), ctx.project.configFile);
    if (model === undefined) return [];
    const findings: Finding[] = [];
    for (const typeName of typeNames(model.config)) {
      const declaredFields = fieldNames(model.config, typeName);
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
            where: { module: model.use, path: `types.${typeName}.fields.${field}` },
            message: `the old column "${orphanField}" on content type "${typeName}" still has stored data (${describeCounts(orphanCounts)}); the current field is named "${field}"`,
            suggestion: `add a migration on the running 5.8.x instance (defineMigration) copying "${orphanField}" to "${field}", then run \`kestrel upgrade data\` again to confirm "${orphanField}" is empty`,
            fix: { kind: "none" },
            docs: upgradingDocs("model-underscore-field"),
          });
          continue;
        }
        const id = `${RULE_ID}:${typeName}.${field}`;
        const where = { module: model.use, path: `types.${typeName}.fields.${field}` };
        const counts = storedCounts(ctx, typeName, field);
        const verifiedEmpty = counts !== undefined && Object.values(counts).every((n) => n === 0);
        const hasStoredData = counts !== undefined && Object.values(counts).some((n) => n !== null && n > 0);
        const defaultName = field.replace(/^_+/, "");
        const answer = ctx.answers.get(questionId(typeName, field));
        const target = answer === "remove" ? undefined : (answer ?? (verifiedEmpty ? defaultName : undefined));

        if (verifiedEmpty && target !== undefined) {
          const source = ctx.readFile(model.file);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = renameContentField(model.file, source, { use: model.use, typeName, from: field, to: target, ...(ctx.locateModelFields === undefined ? {} : { locateModelFields: ctx.locateModelFields }) });
            if (edit) edits.push(edit);
          }
          findings.push(finding(id, RULE_ID, `"${field}" on content type "${typeName}" starts with "_"; a data report counted zero stored values (${describeCounts(counts)})`, `rename to "${target}"`, where, edits, upgradingDocs("model-underscore-field")));
          continue;
        }
        if (answer !== undefined && answer !== "remove") {
          const source = ctx.readFile(model.file);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = renameContentField(model.file, source, { use: model.use, typeName, from: field, to: answer, ...(ctx.locateModelFields === undefined ? {} : { locateModelFields: ctx.locateModelFields }) });
            if (edit) edits.push(edit);
          }
          const proof = counts === undefined ? "no data report was supplied" : `a data report counted stored values (${describeCounts(counts)})`;
          findings.push(
            finding(
              id,
              RULE_ID,
              `"${field}" on content type "${typeName}" starts with "_"`,
              `renamed to "${answer}" — ${proof}, not a proving zero count; the old column "${field}" on "${typeName}" may still hold data. Add a migration on the running 5.8.x instance before it upgrades, then run \`kestrel upgrade data --db <file> --out <report>.json\` and check again with --data-report <report>.json to clear this warning`,
              where,
              edits,
              upgradingDocs("model-underscore-field"),
              "warning",
            ),
          );
          continue;
        }

        const fix: AskFix = {
          kind: "ask",
          question: questionId(typeName, field),
          prompt: counts === undefined ? `rename "${field}" on "${typeName}" to (no data report supplied; run \`kestrel upgrade data\` first, or see docs/upgrading.md#model-underscore-field)` : `rename "${field}" on "${typeName}" to`,
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
              ? "run `kestrel upgrade data --db <file> --out <report>.json` against a copy of the store, then check again with --data-report <report>.json — see docs/upgrading.md#model-underscore-field"
              : "a stored value exists in at least one locale; add a migration on the running 5.8.x instance (defineMigration) copying it to the new key before upgrading",
          fix,
          docs: upgradingDocs("model-underscore-field"),
        });
      }
    }
    return findings;
  },
};

export const underscoreFieldRules: readonly Rule[] = [underscoreFieldRule];
