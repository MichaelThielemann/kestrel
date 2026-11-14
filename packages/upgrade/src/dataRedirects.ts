import { isErr } from "@michaelthielemann/kestrel/result";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { isRecord } from "./guards.ts";
import type { Finding } from "./report.ts";
import { upgradingDocs } from "./ruleHelpers.ts";

const DEFAULT_RESERVED_PATHS = ["/admin", "/api", "/media"];
const SHOWN = 5;

interface RulesRow extends Document {
  [field: string]: unknown;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : undefined;
}

function canonical(from: string): string {
  return `/${from.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function reservedBy(from: string, reservedPaths: readonly string[]): string | undefined {
  const path = canonical(from);
  return reservedPaths.find((reserved) => path === reserved || path.startsWith(`${reserved}/`));
}

/** The stored redirect rules whose source lies at or below a reserved path: publishing leaves them out from 6.0.0 on. `config` is the project's `redirects-default` config, `undefined` without the module. */
export async function redirectReservedPathFindings(db: Persistence, config: unknown): Promise<Finding[]> {
  if (config === undefined) return [];
  const settings = isRecord(config) ? config : {};
  const collection = typeof settings.type === "string" ? settings.type : "redirects";
  const field = typeof settings.field === "string" ? settings.field : "rules";
  const reservedPaths = stringList(settings.reservedPaths) ?? DEFAULT_RESERVED_PATHS;
  try {
    const ensured = await db.ensureCollection(collection, { [field]: "json" });
    if (isErr(ensured)) return [];
    const rows = await db.findMany<RulesRow>(collection, {}, { limit: 10 });
    if (isErr(rows)) return [];
    const hits: string[] = [];
    for (const row of rows.value.items) {
      const rules = row[field];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (isRecord(rule) && typeof rule.from === "string" && reservedBy(rule.from, reservedPaths) !== undefined) hits.push(canonical(rule.from));
      }
    }
    if (hits.length === 0) return [];
    const shown = hits.slice(0, SHOWN).join(", ");
    return [
      {
        id: `data/redirect-reserved-paths:${collection}`,
        rule: "data/redirect-reserved-paths",
        severity: "warning",
        tier: "data",
        where: { path: collection },
        message: `${hits.length} stored redirect rule(s) have a source at or below a reserved path (${shown}${hits.length > SHOWN ? `, and ${hits.length - SHOWN} more` : ""}); redirects-default refuses such a source in 6.0.0 and leaves a stored one out of the published list`,
        suggestion: `remove or move these rules in the redirect editor; reservedPaths of redirects-default (${reservedPaths.join(", ")}) names what it keeps`,
        fix: { kind: "manual" },
        docs: upgradingDocs("data-redirect-reserved-paths"),
      },
    ];
  } catch {
    return [];
  }
}
