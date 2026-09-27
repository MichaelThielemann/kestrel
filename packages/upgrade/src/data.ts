import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { effectiveModuleConfig } from "@michaelthielemann/kestrel";
import { loadConfig } from "@michaelthielemann/kestrel/load";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { isErr } from "@michaelthielemann/kestrel/result";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { trackTempDir, untrackTempDir } from "./cleanup.ts";
import { isRecord } from "./guards.ts";
import type { DataContentModel, DataRoute, UpgradePlugin } from "./plugin.ts";
import { detectPlugin } from "./pluginRules.ts";
import { loadIssuesAsFindings } from "./project.ts";
import type { Finding, UpgradeReport } from "./report.ts";
import { summarize } from "./report.ts";
import { hookFailedFinding, upgradingDocs } from "./ruleHelpers.ts";
import { useToken } from "./useToken.ts";
import { toolVersion } from "./versions.ts";

export interface DataStepResult {
  exitCode: number;
  report?: UpgradeReport;
  error?: string;
}

const QUEUE_SCHEMA = {
  name: "string",
  payload: "json",
  pipeline: "string",
  state: "string",
  attempts: "number",
  createdAt: "number",
  availableAt: "number",
  lockedAt: "number",
  lockedBy: "string",
  finishedAt: "number",
  error: "string",
  runId: "string",
} as const;

interface QueueRow extends Document {
  name: string;
  pipeline: string | null;
}

async function copyWithSiblings(file: string, dir: string): Promise<string> {
  const dest = join(dir, "kestrel.db");
  await copyFile(file, dest);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${file}${suffix}`)) await copyFile(`${file}${suffix}`, `${dest}${suffix}`);
  }
  return dest;
}

function quickCheckOk(file: string): boolean {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0]!)[0] === "ok";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

interface PersistenceSqliteModule {
  createPersistenceSqlite(config: { file: string }, deps?: { logger?: unknown }): Persistence & { close(): void };
}

async function loadProjectPersistenceSqlite(root: string): Promise<PersistenceSqliteModule | undefined> {
  try {
    const require = createRequire(pathToFileURL(resolve(root, "package.json")).href);
    const implFile = require.resolve("@michaelthielemann/kestrel-persistence-sqlite/impl");
    const mod: unknown = await import(pathToFileURL(implFile).href);
    return boundaryCast<PersistenceSqliteModule>(mod, "host");
  } catch {
    return undefined;
  }
}

async function queueFindings(db: Persistence): Promise<{ findings: Finding[]; error?: string }> {
  const ensured = await db.ensureCollection("events_queue", QUEUE_SCHEMA);
  if (isErr(ensured)) return { findings: [], error: `could not read the events_queue collection: ${ensured.error.message}` };

  const unfanned = await db.findMany<QueueRow>("events_queue", { pipeline: null, state: { in: ["pending", "running"] } }, { limit: 10_000 });
  if (isErr(unfanned)) return { findings: [], error: `could not read pending/running rows from events_queue: ${unfanned.error.message}` };
  const dead = await db.findMany<QueueRow>("events_queue", { pipeline: null, state: "dead" }, { limit: 10_000 });
  if (isErr(dead)) return { findings: [], error: `could not read dead rows from events_queue: ${dead.error.message}` };

  const byEvent = new Map<string, number>();
  for (const row of unfanned.value.items) byEvent.set(row.name, (byEvent.get(row.name) ?? 0) + 1);

  const findings: Finding[] = [...byEvent.entries()].map(([event, n]) => ({
    id: `data/queue-unfanned:${event}`,
    rule: "data/queue-unfanned",
    severity: "warning",
    tier: "data",
    where: { path: event },
    message: `${n} stored event(s) named "${event}" are not yet fanned out to a pipeline`,
    suggestion: "at the first 6.0 tick these fan out to every pipeline subscribed then; drain the queue at cutover",
    fix: { kind: "none" },
    docs: upgradingDocs("cutover"),
  }));

  const deadRows = dead.value.items;
  if (deadRows.length > 0) {
    findings.push({
      id: "data/queue-dead-unassigned",
      rule: "data/queue-dead-unassigned",
      severity: "info",
      tier: "data",
      where: {},
      message: `${deadRows.length} dead-letter row(s) have no pipeline assigned`,
      suggestion: "a retry re-fans them out to every pipeline currently subscribed",
      fix: { kind: "none" },
      docs: upgradingDocs("cutover"),
    });
  }
  return { findings };
}

function contentDefaultModel(config: unknown): DataContentModel | undefined {
  if (!isRecord(config) || !isRecord(config.types)) return undefined;
  const types: Record<string, { fields: Record<string, { localized?: boolean }> }> = {};
  for (const [typeName, type] of Object.entries(config.types)) {
    if (!isRecord(type) || !isRecord(type.fields)) continue;
    const fields: Record<string, { localized?: boolean }> = {};
    for (const [field, def] of Object.entries(type.fields)) fields[field] = { localized: isRecord(def) && def.localized === true };
    types[typeName] = { fields };
  }
  const locales = config.locales;
  return {
    types,
    ...(Array.isArray(locales) ? { locales: locales.filter((l): l is string => typeof l === "string") } : {}),
    ...(typeof config.defaultLocale === "string" ? { defaultLocale: config.defaultLocale } : {}),
  };
}

function siteDefaultRoutes(config: unknown): Record<string, DataRoute> | undefined {
  if (!isRecord(config) || !isRecord(config.routes)) return undefined;
  const routes: Record<string, DataRoute> = {};
  for (const [type, route] of Object.entries(config.routes)) {
    if (!isRecord(route)) continue;
    routes[type] = { ...(typeof route.slugField === "string" ? { slugField: route.slugField } : {}), ...(isRecord(route.liveWhen) ? { liveWhen: route.liveWhen } : {}) };
  }
  return routes;
}

function configLoadFailedFinding(err: unknown, pluginKind: string | undefined): Finding {
  const detail = err instanceof Error ? err.message : String(err);
  if (pluginKind !== undefined) {
    return {
      id: "data/config-load-failed",
      rule: "data/config-load-failed",
      severity: "warning",
      tier: "data",
      where: {},
      message: `the "${pluginKind}" plugin provides no dataModel hook, and kestrel.config.ts could not be loaded without it: ${detail}`,
      suggestion: `implement dataModel(root) on the "${pluginKind}" plugin, or count again with --data-report`,
      fix: { kind: "manual" },
      docs: upgradingDocs("data-config-load-failed"),
    };
  }
  return {
    id: "data/config-load-failed",
    rule: "data/config-load-failed",
    severity: "error",
    tier: "data",
    where: {},
    message: `kestrel.config.ts could not be loaded: ${detail}`,
    suggestion: "fix the config so it loads, then run data again to check underscore fields",
    fix: { kind: "manual" },
    docs: upgradingDocs("data-config-load-failed"),
  };
}

async function builtInDataModel(root: string, pluginKind: string | undefined): Promise<{ model?: DataContentModel | undefined; issue?: Finding }> {
  const configFile = join(root, "kestrel.config.ts");
  if (!existsSync(configFile)) return {};
  try {
    const config = await loadConfig(configFile);
    const entry = config.modules.find((m) => useToken(m.use) === "content-default");
    const model = contentDefaultModel(entry === undefined ? undefined : effectiveModuleConfig(entry));
    const site = config.modules.find((m) => useToken(m.use) === "site-default");
    const routes = site === undefined ? undefined : siteDefaultRoutes(effectiveModuleConfig(site));
    return { model: model === undefined || routes === undefined ? model : { ...model, routes } };
  } catch (err) {
    return { issue: configLoadFailedFinding(err, pluginKind) };
  }
}

async function activeDataModel(root: string, plugin: UpgradePlugin | undefined): Promise<{ model?: DataContentModel | undefined; issues: Finding[] }> {
  if (plugin?.dataModel === undefined) {
    const { model, issue } = await builtInDataModel(root, plugin?.kind);
    return { model, issues: issue ? [issue] : [] };
  }
  try {
    return { model: await plugin.dataModel(root), issues: [] };
  } catch (err) {
    return { issues: [hookFailedFinding(plugin.kind, "dataModel", err)] };
  }
}

const SLUG_PAGE = 500;
const SLUG_SHOWN = 20;

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function matches(stored: unknown, expected: unknown): boolean {
  if (typeof expected === "boolean") return expected ? stored === true || stored === 1 || stored === "1" || stored === "true" : stored === false || stored === 0 || stored === "0" || stored === "false";
  const scalar = (value: unknown): string | undefined => (typeof value === "string" || typeof value === "number" ? String(value) : undefined);
  return scalar(stored) !== undefined && scalar(stored) === scalar(expected);
}

interface SlugHit {
  id: string;
  locale: string;
  copyable: string | null;
}

async function translationSlugHits(db: Persistence, typeName: string, fields: Record<string, { localized?: boolean }>, route: DataRoute, locales: readonly string[], defaultLocale: string): Promise<SlugHit[]> {
  const slugField = route.slugField ?? "slug";
  if (fields[slugField]?.localized !== true) return [];
  const liveWhen = Object.entries(route.liveWhen ?? {});
  const column = (field: string, locale: string): string => (fields[field]?.localized === true ? `${field}__${locale}` : field);
  const localized = Object.keys(fields).filter((field) => fields[field]?.localized === true);
  const columns: Record<string, "string"> = {};
  for (const locale of locales) {
    for (const field of localized) columns[column(field, locale)] = "string";
    for (const [field] of liveWhen) columns[column(field, locale)] = "string";
  }
  try {
    if (isErr(await db.ensureCollection(typeName, columns))) return [];
  } catch {
    return [];
  }
  const live = (row: Document, locale: string): boolean => liveWhen.every(([field, expected]) => matches(row[column(field, locale)], expected));
  const hits: SlugHit[] = [];
  for (let offset = 0; ; offset += SLUG_PAGE) {
    const page = await db.findMany<Document>(typeName, {}, { sort: { id: "asc" }, limit: SLUG_PAGE, offset });
    if (isErr(page)) return hits;
    for (const row of page.value.items) {
      const source = row[column(slugField, defaultLocale)];
      const copyable = live(row, defaultLocale) && typeof source === "string" && source !== "" ? source : null;
      for (const locale of locales) {
        if (locale === defaultLocale || !live(row, locale) || present(row[column(slugField, locale)])) continue;
        if (!localized.some((field) => present(row[column(field, locale)]))) continue;
        hits.push({ id: row.id, locale, copyable });
      }
    }
    if (page.value.items.length < SLUG_PAGE) return hits;
  }
}

async function translationSlugFindings(db: Persistence, model: DataContentModel | undefined): Promise<Finding[]> {
  const locales = model?.locales ?? [];
  if (model?.routes === undefined || locales.length < 2) return [];
  const defaultLocale = model.defaultLocale ?? locales[0] ?? "";
  const findings: Finding[] = [];
  for (const [typeName, route] of Object.entries(model.routes)) {
    const type = model.types[typeName];
    if (type === undefined) continue;
    const hits = await translationSlugHits(db, typeName, type.fields, route, locales, defaultLocale);
    if (hits.length === 0) continue;
    const name = (hit: SlugHit): string => `${hit.id} (${hit.locale})`;
    const listed = (items: SlugHit[], text: (hit: SlugHit) => string): string => `${items.slice(0, SLUG_SHOWN).map(text).join(", ")}${items.length > SLUG_SHOWN ? `, and ${items.length - SLUG_SHOWN} more` : ""}`;
    const copyable = hits.filter((hit) => hit.copyable !== null);
    const manual = hits.filter((hit) => hit.copyable === null);
    const parts = [
      ...(copyable.length === 0 ? [] : [`the default locale is published, so its slug is public already and can be copied: ${listed(copyable, (hit) => `${name(hit)}: "${hit.copyable ?? ""}"`)}`]),
      ...(manual.length === 0 ? [] : [`the default locale is not published, so give each a new slug or withdraw it: ${listed(manual, name)}`]),
    ];
    findings.push({
      id: `data/translation-slug:${typeName}`,
      rule: "data/translation-slug",
      severity: "error",
      tier: "data",
      where: { path: typeName },
      message: `${hits.length} translation(s) of "${typeName}" are published without a slug of their own, so 6.0.0 serves none of them and refuses to save them published: ${listed(hits, name)}`,
      suggestion: `set a slug in that locale or withdraw the translation; ${parts.join("; ")}`,
      fix: { kind: "manual" },
      docs: upgradingDocs("data-translation-slug"),
    });
  }
  return findings;
}

async function pluginDataFindings(db: Persistence, root: string, plugin: UpgradePlugin | undefined, model: DataContentModel | undefined): Promise<Finding[]> {
  if (plugin?.dataFindings === undefined) return [];
  try {
    return [...(await plugin.dataFindings(db, root, model))];
  } catch (err) {
    return [hookFailedFinding(plugin.kind, "dataFindings", err)];
  }
}

function contentFieldsOf(model: DataContentModel): Array<{ typeName: string; field: string; localized: boolean }> {
  const out: Array<{ typeName: string; field: string; localized: boolean }> = [];
  for (const [typeName, type] of Object.entries(model.types)) {
    for (const [field, def] of Object.entries(type.fields)) out.push({ typeName, field, localized: def.localized === true });
  }
  return out;
}

function declaredFieldsByType(model: DataContentModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [typeName, type] of Object.entries(model.types)) out.set(typeName, new Set(Object.keys(type.fields)));
  return out;
}

function localesOf(model: DataContentModel): string[] {
  return model.locales === undefined ? [] : [...model.locales];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function existingColumns(file: string, table: string): Set<string> | undefined {
  if (!IDENTIFIER.test(table)) return undefined;
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (exists === undefined) return undefined;
    const rows = boundaryCast<Array<{ name: string }>>(raw.prepare(`PRAGMA table_info("${table}")`).all(), "host");
    return new Set(rows.map((r) => r.name));
  } finally {
    raw.close();
  }
}

async function countColumn(db: Persistence, typeName: string, column: string): Promise<number | null> {
  try {
    const ensured = await db.ensureCollection(typeName, { [column]: "string" });
    if (isErr(ensured)) return null;
    const counted = await db.count(typeName, { [column]: { ne: null } });
    return isErr(counted) ? null : counted.value;
  } catch {
    return null;
  }
}

async function underscoreFieldCounts(file: string, db: Persistence, contentModel: DataContentModel): Promise<Record<string, Record<string, number | null>>> {
  const locales = localesOf(contentModel);
  const declaredFields = declaredFieldsByType(contentModel);
  const columnsByType = new Map<string, Set<string> | undefined>();
  const counts: Record<string, Record<string, number | null>> = {};
  for (const { typeName, field, localized } of contentFieldsOf(contentModel)) {
    const shadowField = field.startsWith("_") ? field : `_${field}`;
    const isOrphanProbe = shadowField !== field;
    if (isOrphanProbe && declaredFields.get(typeName)?.has(shadowField)) continue;
    if (!columnsByType.has(typeName)) columnsByType.set(typeName, existingColumns(file, typeName));
    const columns = columnsByType.get(typeName);
    const columnsOf = localized ? locales.map((locale) => ({ locale, column: `${shadowField}__${locale}` })) : [{ locale: "unlocalized", column: shadowField }];
    if (isOrphanProbe && (columns === undefined || !columnsOf.some((c) => columns.has(c.column)))) continue;

    const perLocale: Record<string, number | null> = {};
    for (const { locale, column } of columnsOf) {
      if (columns === undefined || !columns.has(column)) {
        perLocale[locale] = null;
        continue;
      }
      perLocale[locale] = await countColumn(db, typeName, column);
    }
    counts[`${typeName}.${shadowField}`] = perLocale;
  }
  return counts;
}

function describeCounts(counts: Record<string, number | null>): string {
  return Object.entries(counts)
    .map(([locale, n]) => {
      if (n === null) return locale === "unlocalized" ? "not counted" : `not counted in "${locale}"`;
      return locale === "unlocalized" ? `${n} stored value(s)` : `${n} in "${locale}"`;
    })
    .join(", ");
}

function underscoreFieldFindings(counts: Record<string, Record<string, number | null>>): Finding[] {
  const findings: Finding[] = [];
  for (const [key, perLocale] of Object.entries(counts)) {
    if (Object.values(perLocale).every((n) => n === 0)) continue;
    findings.push({
      id: `data/underscore-field-stored:${key}`,
      rule: "data/underscore-field-stored",
      severity: "warning",
      tier: "data",
      where: { path: key },
      message: `"${key}": ${describeCounts(perLocale)}`,
      suggestion: "add a migration on the running 5.8.x instance (defineMigration) copying it to the new key before upgrading",
      fix: { kind: "none" },
      docs: upgradingDocs("model-underscore-field"),
    });
  }
  return findings;
}

async function moduleConfigOf(root: string, token: string): Promise<unknown> {
  try {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const entry = config.modules.find((m) => useToken(m.use) === token);
    return entry === undefined ? undefined : effectiveModuleConfig(entry);
  } catch {
    return undefined;
  }
}

function isCanonicalMediaKey(key: string, id: string, prefix: string): boolean {
  const want = `${prefix}${id}/`;
  return key.startsWith(want) && key.length > want.length && !key.slice(want.length).includes("/");
}

interface MediaItemRow extends Document {
  id: string;
  key: string;
}

async function mediaItemsLayoutFindings(db: Persistence, prefix: string): Promise<Finding[]> {
  try {
    const ensured = await db.ensureCollection("media_items", { key: "string" });
    if (isErr(ensured)) return [];
    const rows = await db.findMany<MediaItemRow>("media_items", {}, { limit: 10_000 });
    if (isErr(rows)) return [];
    const offLayout = rows.value.items.filter((r) => !isCanonicalMediaKey(r.key, r.id, prefix));
    if (offLayout.length === 0) return [];
    return [
      {
        id: "data/media-layout:media_items",
        rule: "data/media-layout",
        severity: "error",
        tier: "data",
        where: { path: "media_items" },
        message: `${offLayout.length} media_items row(s) use a blob key other than "${prefix}<id>/<name>" (first: ${offLayout[0]!.id} at "${offLayout[0]!.key}")`,
        suggestion: "media-default's setup() refuses to start with these; start 6.0.0 with an empty media store, or migrate the blob keys to the new layout by hand before upgrading",
        fix: { kind: "none" },
        docs: upgradingDocs("data-media-layout"),
      },
    ];
  } catch {
    return [];
  }
}

async function unslottedCollectionFinding(db: Persistence, collection: string): Promise<Finding | undefined> {
  try {
    const ensured = await db.ensureCollection(collection, { slot: "string" });
    if (isErr(ensured)) return undefined;
    const unslotted = await db.count(collection, { slot: { eq: null } });
    if (isErr(unslotted) || unslotted.value === 0) return undefined;
    return {
      id: `data/media-layout:${collection}`,
      rule: "data/media-layout",
      severity: "error",
      tier: "data",
      where: { path: collection },
      message: `${unslotted.value} row(s) in ${collection} have no slot; they were written before 6.0.0 and images-default's setup() refuses to start with any`,
      suggestion: `start 6.0.0 with an empty "${collection}" collection`,
      fix: { kind: "none" },
      docs: upgradingDocs("data-media-layout"),
    };
  } catch {
    return undefined;
  }
}

async function mediaLayoutFindings(root: string, db: Persistence): Promise<Finding[]> {
  const mediaConfig = await moduleConfigOf(root, "media-default");
  const prefix = isRecord(mediaConfig) && typeof mediaConfig.prefix === "string" ? mediaConfig.prefix : "media/";
  const findings = await mediaItemsLayoutFindings(db, prefix);
  for (const collection of ["images_variants", "images_retired"]) {
    const finding = await unslottedCollectionFinding(db, collection);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}

interface BlobstoreFilesystemInfo {
  root: string;
}

async function blobstoreFilesystemConfig(root: string): Promise<BlobstoreFilesystemInfo | undefined> {
  const config = await moduleConfigOf(root, "blobstore-filesystem");
  return isRecord(config) && typeof config.root === "string" ? { root: config.root } : undefined;
}

async function siteMediaLeftoversFindings(root: string): Promise<Finding[]> {
  const blobstore = await blobstoreFilesystemConfig(root);
  if (blobstore === undefined) return [];
  const deliveryConfig = await moduleConfigOf(root, "delivery-static");
  if (!isRecord(deliveryConfig)) return [];
  const deliveryPrefix = typeof deliveryConfig.prefix === "string" ? deliveryConfig.prefix : "";
  const media = deliveryConfig.media;
  const target = isRecord(media) && typeof media.target === "string" ? media.target : "media/";
  const leftoversDir = resolve(root, blobstore.root, deliveryPrefix, target);
  try {
    const entries = await readdir(leftoversDir, { withFileTypes: true });
    if (entries.length === 0) return [];
    return [
      {
        id: "data/site-media-leftovers",
        rule: "data/site-media-leftovers",
        severity: "warning",
        tier: "data",
        where: { path: leftoversDir },
        message: `${entries.length} entr${entries.length === 1 ? "y" : "ies"} found under "${leftoversDir}", the 5.x delivery-static media export directory`,
        suggestion: 'review these by hand; media.syncPublic never touches this tree. Republish every page that might still link one of them, then delete the directory',
        fix: { kind: "manual" },
        docs: upgradingDocs("data-site-media-leftovers"),
      },
    ];
  } catch {
    return [];
  }
}

const TMP_SUFFIX = ".kestrel-tmp";
const TMP_SUFFIX_SCAN_LIMIT = 20_000;
const TMP_SUFFIX_MAX_DEPTH = 8;

async function collectTmpSuffixedFiles(dir: string, depth: number, visited: { count: number }, found: string[]): Promise<void> {
  if (depth > TMP_SUFFIX_MAX_DEPTH || visited.count > TMP_SUFFIX_SCAN_LIMIT) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    visited.count++;
    if (visited.count > TMP_SUFFIX_SCAN_LIMIT) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectTmpSuffixedFiles(full, depth + 1, visited, found);
    else if (entry.name.endsWith(TMP_SUFFIX)) found.push(full);
  }
}

async function blobstoreTmpSuffixFindings(root: string): Promise<Finding[]> {
  const blobstore = await blobstoreFilesystemConfig(root);
  if (blobstore === undefined) return [];
  const storeRoot = resolve(root, blobstore.root);
  const found: string[] = [];
  await collectTmpSuffixedFiles(storeRoot, 0, { count: 0 }, found);
  if (found.length === 0) return [];
  return [
    {
      id: "data/blobstore-tmp-suffix",
      rule: "data/blobstore-tmp-suffix",
      severity: "info",
      tier: "data",
      where: { path: storeRoot },
      message: `${found.length} stored key(s) already end in "${TMP_SUFFIX}" (first: "${found[0]}")`,
      suggestion: "rename these keys by hand if they are meant to stay readable; 6.0.0 treats this suffix as its own atomic-write temp file and skips it",
      fix: { kind: "none" },
      docs: upgradingDocs("data-blobstore-tmp-suffix"),
    },
  ];
}

/** Copies `dbFile` (and any `-wal`/`-shm` siblings), verifies the copy with `PRAGMA quick_check`, then reads it through the project's own persistence-sqlite; the given file is never opened after the copy. The copy directory is always removed before returning, whether the step succeeds or refuses. */
export async function runDataStep(dbFile: string, root: string, plugins: readonly UpgradePlugin[] = []): Promise<DataStepResult> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-"));
  trackTempDir(dir);
  try {
    let copy: string;
    try {
      copy = await copyWithSiblings(dbFile, dir);
    } catch (err) {
      return { exitCode: 2, error: `cannot copy "${dbFile}": ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!quickCheckOk(copy)) {
      return { exitCode: 2, error: `the copy of "${dbFile}" did not pass PRAGMA quick_check; take a consistent snapshot (persistence.snapshot, a replication snapshot, or "sqlite3 <db> .backup <copy>") and try again` };
    }
    const mod = await loadProjectPersistenceSqlite(root);
    if (mod === undefined) return { exitCode: 2, error: "the project's own @michaelthielemann/kestrel-persistence-sqlite could not be resolved; install the project's dependencies first" };
    const db = mod.createPersistenceSqlite({ file: copy }, { logger: silentLogger });
    let queued: { findings: Finding[]; error?: string };
    let counts: Record<string, Record<string, number | null>>;
    let mediaLayout: Finding[];
    let dataModelIssues: Finding[];
    let fromPlugin: Finding[];
    let translationSlugs: Finding[];
    try {
      queued = await queueFindings(db);
      if (queued.error !== undefined) return { exitCode: 2, error: queued.error };
      const { plugin, issues: detectIssues } = await detectPlugin(plugins, root);
      const { model: contentModel, issues } = await activeDataModel(root, plugin);
      dataModelIssues = [...loadIssuesAsFindings(detectIssues), ...issues];
      counts = contentModel === undefined ? {} : await underscoreFieldCounts(copy, db, contentModel);
      mediaLayout = await mediaLayoutFindings(root, db);
      translationSlugs = await translationSlugFindings(db, contentModel);
      fromPlugin = await pluginDataFindings(db, root, plugin, contentModel);
    } finally {
      db.close();
    }
    const [siteMediaLeftovers, blobstoreTmpSuffix] = await Promise.all([siteMediaLeftoversFindings(root), blobstoreTmpSuffixFindings(root)]);
    const findings = [...queued.findings, ...underscoreFieldFindings(counts), ...mediaLayout, ...translationSlugs, ...siteMediaLeftovers, ...blobstoreTmpSuffix, ...dataModelIssues, ...fromPlugin];
    const report: UpgradeReport = {
      schema: 1,
      tool: { name: "kestrel-upgrade", version: toolVersion() },
      target: "6.0.0",
      project: { root, kind: "data", installed: {} },
      tiers: { source: "not-run", load: "not-run", boot: "not-run", data: "done" },
      summary: summarize(findings),
      findings,
      underscoreFields: counts,
    };
    const exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
    return { exitCode, report };
  } finally {
    untrackTempDir(dir);
    await rm(dir, { recursive: true, force: true });
  }
}
