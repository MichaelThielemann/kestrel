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

function segmentPattern(segment: string): string {
  return segment.replace(/[.+?^${}()|[\]\\-]/g, "\\$&").split("*").join("[^/]+");
}

function matchesReserved(path: string, reserved: string): boolean {
  const pattern = path.split("/").slice(1);
  for (const [i, wanted] of reserved.split("/").slice(1).entries()) {
    const segment = pattern[i];
    if (segment === undefined) return false;
    const deep = segment.indexOf("**");
    if (deep !== -1) return new RegExp(`^${segmentPattern(segment.slice(0, deep))}`).test(wanted);
    if (!new RegExp(`^${segmentPattern(segment)}$`).test(wanted)) return false;
  }
  return true;
}

function reservedBy(from: string, reservedPaths: readonly string[]): string | undefined {
  const path = canonical(from);
  return reservedPaths.find((reserved) => matchesReserved(path, reserved));
}

const AUTO_PATHS = "redirects_auto_paths";
const PAGE = 200;

interface AutoPathRow extends Document {
  kind: string;
}

function finding(collection: string, hits: string[], what: string, reservedPaths: readonly string[], consequence: string): Finding[] {
  if (hits.length === 0) return [];
  const shown = hits.slice(0, SHOWN).join(", ");
  return [
    {
      id: `data/redirect-reserved-paths:${collection}`,
      rule: "data/redirect-reserved-paths",
      severity: "warning",
      tier: "data",
      where: { path: collection },
      message: `${hits.length} ${what} (${shown}${hits.length > SHOWN ? `, and ${hits.length - SHOWN} more` : ""}); ${consequence}`,
      suggestion: `remove or move these redirects; reservedPaths of redirects-default (${reservedPaths.join(", ")}) names what it keeps`,
      fix: { kind: "manual" },
      docs: upgradingDocs("data-redirect-reserved-paths"),
    },
  ];
}

async function attempt(run: () => Promise<Finding[]>): Promise<Finding[]> {
  try {
    return await run();
  } catch {
    return [];
  }
}

async function storedRuleHits(db: Persistence, settings: Record<string, unknown>, reservedPaths: readonly string[]): Promise<string[]> {
  const collection = typeof settings.type === "string" ? settings.type : "redirects";
  const field = typeof settings.field === "string" ? settings.field : "rules";
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
  return hits;
}

async function automaticHits(db: Persistence, reservedPaths: readonly string[]): Promise<string[]> {
  const ensured = await db.ensureCollection(AUTO_PATHS, { kind: "string", type: "string", docId: "string", locale: "string", seq: "number" });
  if (isErr(ensured)) return [];
  const hits: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await db.findMany<AutoPathRow>(AUTO_PATHS, { kind: "redirect" }, { sort: { id: "asc" }, limit: PAGE, offset });
    if (isErr(page)) return hits;
    for (const row of page.value.items) {
      if (reservedBy(row.id, reservedPaths) !== undefined) hits.push(canonical(row.id));
    }
    if (page.value.items.length < PAGE) return hits;
  }
}

/** The stored redirect rules and the stored automatic redirects whose source can match a reserved path, wildcards included: publishing leaves them out from 6.0.0 on. `config` is the project's `redirects-default` config, `undefined` without the module. */
export async function redirectReservedPathFindings(db: Persistence, config: unknown): Promise<Finding[]> {
  if (config === undefined) return [];
  const settings = isRecord(config) ? config : {};
  const collection = typeof settings.type === "string" ? settings.type : "redirects";
  const reservedPaths = stringList(settings.reservedPaths) ?? DEFAULT_RESERVED_PATHS;
  const rules = await attempt(async () => finding(collection, await storedRuleHits(db, settings, reservedPaths), "stored redirect rule(s) have a source that can match a reserved path", reservedPaths, "redirects-default refuses such a source in 6.0.0 and leaves a stored one out of the published list"));
  const automatic = await attempt(async () => finding(AUTO_PATHS, await automaticHits(db, reservedPaths), "stored automatic redirect(s) have a source at a reserved path", reservedPaths, "redirects-default leaves an automatic redirect from such a path out of the lookup and the published list in 6.0.0"));
  return [...rules, ...automatic];
}
