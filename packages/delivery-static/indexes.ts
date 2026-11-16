import { createHash } from "node:crypto";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { publishedLocale } from "@michaelthielemann/kestrel-contracts/helpers/content-locale";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import { pageUrl } from "./site-url.ts";
import { BODY_HEADING_OFFSET, bodyOf, buildLlmsTxt, extractMain, htmlToMarkdown, LLMS_CONTENT_TYPE, LLMS_FULL_KEY, LLMS_KEY, llmsFullPieces, type LlmsConfig, type LlmsFullPage, type LlmsFullSection, type LlmsSection } from "./llms.ts";

export { normalizeSiteUrl, pageUrl } from "./site-url.ts";

export const SITEMAP_KEY = "sitemap.xml";
export const ROBOTS_KEY = "robots.txt";
export const SITEMAP_CONTENT_TYPE = "application/xml; charset=utf-8";
export const ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";

/** The content type each index file is written with, keyed by its name under the prefix. */
export const INDEX_FILE_TYPES = { [SITEMAP_KEY]: SITEMAP_CONTENT_TYPE, [ROBOTS_KEY]: ROBOTS_CONTENT_TYPE, [LLMS_KEY]: LLMS_CONTENT_TYPE, [LLMS_FULL_KEY]: LLMS_CONTENT_TYPE } as const;

export type IndexFileName = keyof typeof INDEX_FILE_TYPES;

export const INDEX_FILE_NAMES: readonly IndexFileName[] = [SITEMAP_KEY, ROBOTS_KEY, LLMS_KEY, LLMS_FULL_KEY];

export function isIndexFileName(name: string): name is IndexFileName {
  return INDEX_FILE_NAMES.some((known) => known === name);
}

/** One index file as an export stored it under the prefix. */
export interface IndexFile {
  name: IndexFileName;
  data: Uint8Array;
  /** The content type the export writes this file with. */
  contentType: string;
  /** The sha256 of `data`, hex. */
  sha256: string;
}

/** Reads `<prefix><name>` as an export stored it; `null` when there is none. Writes nothing and starts no export. */
export async function readIndexFile(blobs: Blobstore, prefix: string, name: IndexFileName): Promise<Result<IndexFile | null, KestrelError>> {
  const read = await blobs.get(`${prefix}${name}`);
  if (isErr(read)) return read.error.code === "NOT_FOUND" ? ok(null) : read;
  if (read.value === null) return ok(null);
  return ok({ name, data: read.value, contentType: INDEX_FILE_TYPES[name], sha256: sha256(read.value) });
}

export type RobotsPolicy = "allow" | "disallow";

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&apos;"));
}

export interface SitemapAlternate {
  hreflang: string;
  href: string;
}

export interface SitemapUrl {
  loc: string;
  /** Epoch milliseconds; left out of the file when absent. */
  lastmod?: number;
  alternates?: SitemapAlternate[];
}

export function buildSitemapXml(urls: readonly SitemapUrl[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'];
  for (const url of [...urls].sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0))) {
    lines.push("  <url>", `    <loc>${escapeXml(url.loc)}</loc>`);
    if (url.lastmod !== undefined) lines.push(`    <lastmod>${new Date(url.lastmod).toISOString()}</lastmod>`);
    for (const alt of url.alternates ?? []) lines.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}"/>`);
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return `${lines.join("\n")}\n`;
}

export function buildRobotsTxt(opts: { policy: RobotsPolicy; extra: readonly string[]; sitemapUrl?: string | undefined }): string {
  const lines = ["User-agent: *", opts.policy === "allow" ? "Allow: /" : "Disallow: /", ...opts.extra];
  if (opts.sitemapUrl !== undefined) lines.push("", `Sitemap: ${opts.sitemapUrl}`);
  return `${lines.join("\n")}\n`;
}

/** A status row that serves a file: it has a path and is `live` or `error`. */
export interface IndexCandidate {
  rowId: string;
  type: string;
  docId: string;
  locale: string;
  path: string;
  state: "live" | "error";
  html(): Promise<Result<string | null, KestrelError>>;
}

/** A candidate whose document is still published and not `noindex`, with what the index files show of it. */
export interface IndexEntry extends IndexCandidate {
  url: string;
  title: string;
  description?: string;
  updatedAt: number;
}

function preferred(a: IndexEntry, b: IndexEntry): IndexEntry {
  if (a.state !== b.state) return a.state === "live" ? a : b;
  return a.rowId <= b.rowId ? a : b;
}

/** One entry per URL, the `live` row first and then the lower row id, sorted by URL. */
export function dedupeEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  const byUrl = new Map<string, IndexEntry>();
  for (const entry of entries) {
    const seen = byUrl.get(entry.url);
    byUrl.set(entry.url, seen === undefined ? entry : preferred(seen, entry));
  }
  return [...byUrl.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** The sitemap URLs of the entries: `lastmod` only for `live` entries, and the locales of one document as alternates of each other plus `x-default` for the default locale, when a document has more than one. */
export function sitemapUrls(entries: readonly IndexEntry[], defaultLocale: string | undefined): SitemapUrl[] {
  const groups = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    if (entry.locale === "") continue;
    const key = `${entry.type}\u0000${entry.docId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return entries.map((entry) => {
    const group = groups.get(`${entry.type}\u0000${entry.docId}`) ?? [];
    const alternates: SitemapAlternate[] = [];
    if (group.length > 1) {
      for (const member of [...group].sort((a, b) => (a.locale < b.locale ? -1 : 1))) alternates.push({ hreflang: member.locale, href: member.url });
      const fallback = group.find((member) => member.locale === defaultLocale);
      if (fallback !== undefined) alternates.push({ hreflang: "x-default", href: fallback.url });
    }
    return { loc: entry.url, ...(entry.state === "live" ? { lastmod: entry.updatedAt } : {}), ...(alternates.length > 0 ? { alternates } : {}) };
  });
}

export interface IndexFilesConfig {
  siteUrl: string | undefined;
  sitemap: boolean;
  /** `null` leaves robots.txt alone. */
  robots: { policy: RobotsPolicy; extra: string[] } | null;
  llms: LlmsConfig;
  prefix: string;
}

export interface IndexFilesDeps {
  content: Content;
  blobs: Blobstore;
  logger: Logger;
  fallback: boolean;
  defaultLocale: string | undefined;
  hasLocales: boolean;
  types: string[];
  filterFor(type: string): Filter;
  /** Visits every candidate of `type` in pages. */
  candidates(type: string, visit: (page: IndexCandidate[]) => Promise<Result<void, KestrelError>>): Promise<Result<void, KestrelError>>;
  /** Whether any document of a delivered type is published in any delivered locale. */
  publishedExists(): Promise<Result<boolean, KestrelError>>;
  /** The sha256 (hex) of the `sitemap.xml` or `llms-full.txt` an export last wrote under the prefix, kept across restarts; `null` when none. */
  written: {
    read(file: OwnedFile): Promise<Result<string | null, KestrelError>>;
    write(file: OwnedFile, hash: string | null): Promise<Result<void, KestrelError>>;
  };
  stopping(): boolean;
  /** Runs work that came due meanwhile; called before each page an llms-full.txt export reads. */
  interleave(): Promise<void>;
}

/** An index file that is removed only while it still holds what an export of this module wrote. */
export type OwnedFile = "sitemap" | "llmsFull";

/** How many entries an export wrote; `skipped` when it wrote no list because published documents have no rendered output yet. */
export interface ExportCount {
  entries: number;
  skipped?: true;
}

export interface IndexFiles {
  exportIndexes(): Promise<Result<ExportCount, KestrelError>>;
  exportLlmsFull(): Promise<Result<ExportCount, KestrelError>>;
}

const REMOVED = "-";
const READ_BATCH = 50;
const ENCODE_CHARS = 1 << 18;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function joined(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    if (offset > 0) await nextTurn();
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createIndexFiles(config: IndexFilesConfig, deps: IndexFilesDeps): IndexFiles {
  const { content, blobs, logger } = deps;
  const written = new Map<string, string>();
  const siteOrigin = config.siteUrl === undefined ? undefined : new URL(config.siteUrl).origin;

  const stopped = (): KestrelError => failure("TRANSIENT", "delivery/static: the process is stopping, the export runs again after the restart");

  const encode = async (pieces: Iterable<string>): Promise<Result<{ parts: Uint8Array[]; hash: string }, KestrelError>> => {
    const encoder = new TextEncoder();
    const hash = createHash("sha256");
    const parts: Uint8Array[] = [];
    let pending: string[] = [];
    let pendingChars = 0;
    const flush = (): void => {
      const part = encoder.encode(pending.join(""));
      hash.update(part);
      parts.push(part);
      pending = [];
      pendingChars = 0;
    };
    for (const piece of pieces) {
      if (pendingChars >= ENCODE_CHARS) {
        flush();
        await nextTurn();
        if (deps.stopping()) return err(stopped());
      }
      pending.push(piece);
      pendingChars += piece.length;
    }
    flush();
    return ok({ parts, hash: hash.digest("hex") });
  };

  const putIfChanged = async (name: string, pieces: Iterable<string>, contentType: string): Promise<Result<string, KestrelError>> => {
    const key = `${config.prefix}${name}`;
    const encoded = await encode(pieces);
    if (isErr(encoded)) return encoded;
    const { parts, hash } = encoded.value;
    if (written.get(key) === hash) return ok(hash);
    written.delete(key);
    const put = await blobs.put(key, await joined(parts), { contentType });
    if (isErr(put)) return put;
    written.set(key, hash);
    return ok(hash);
  };

  const removeIfPresent = async (name: string): Promise<Result<void, KestrelError>> => {
    const key = `${config.prefix}${name}`;
    if (written.get(key) === REMOVED) return ok();
    written.delete(key);
    const removed = await blobs.remove(key);
    if (isErr(removed)) return removed;
    written.set(key, REMOVED);
    return ok();
  };

  const header = async (): Promise<Result<{ siteName: string; siteDescription?: string }, KestrelError>> => {
    const settings = config.llms.settings;
    let doc: ContentDocument | null = null;
    if (settings.type in content.model().types) {
      const read = await content.get(settings.type, undefined, deps.hasLocales && deps.defaultLocale !== undefined ? { locale: deps.defaultLocale, fallback: deps.fallback } : {});
      if (isErr(read)) return read;
      doc = read.value;
    }
    const siteName = text(doc?.[settings.titleField]) ?? (config.siteUrl === undefined ? "Website" : new URL(config.siteUrl).host);
    const siteDescription = text(doc?.[settings.descriptionField]);
    return ok({ siteName, ...(siteDescription === undefined ? {} : { siteDescription }) });
  };

  const entryOf = (candidate: IndexCandidate, own: ContentDocument, inherited: ContentDocument | undefined): IndexEntry | null => {
    const field = (name: string): unknown => own[name] ?? inherited?.[name];
    const seo = field(config.llms.seoField);
    const meta = isRecord(seo) ? seo : {};
    if (meta.noindex === true) return null;
    const description = text(meta.description);
    return {
      ...candidate,
      url: pageUrl(config.siteUrl, candidate.path),
      title: text(meta.title) ?? text(field(config.llms.titleField)) ?? candidate.path,
      ...(description === undefined ? {} : { description }),
      updatedAt: own.updatedAt,
    };
  };

  const fallbackSource = (locale: string): string | undefined => (deps.fallback && locale !== "" && deps.defaultLocale !== undefined && locale !== deps.defaultLocale ? deps.defaultLocale : undefined);

  const publishedRows = async (type: string, locale: string, ids: string[]): Promise<Result<Map<string, ContentDocument>, KestrelError>> => {
    const page = await content.list(type, { ...deps.filterFor(type), id: { in: ids } }, { ...(locale === "" ? {} : { locale }), limit: ids.length });
    if (isErr(page)) return page;
    return ok(new Map(page.value.items.map((doc) => [doc.id, doc])));
  };

  const readOneByOne = async (type: string, page: readonly IndexCandidate[], entries: IndexEntry[]): Promise<Result<void, KestrelError>> => {
    for (const candidate of page) {
      if (deps.stopping()) return err(stopped());
      const read = await publishedLocale(content, type, candidate.docId, candidate.locale === "" ? undefined : candidate.locale, deps.filterFor(type), { fallback: deps.fallback, translations: false });
      if (isErr(read)) return read;
      const entry = read.value === null ? null : entryOf(candidate, read.value, undefined);
      if (entry !== null) entries.push(entry);
      await nextTurn();
    }
    return ok();
  };

  const readInBatches = async (type: string, page: readonly IndexCandidate[], entries: IndexEntry[]): Promise<Result<void, KestrelError>> => {
    const byDoc = new Map<string, IndexCandidate[]>();
    for (const candidate of page) byDoc.set(candidate.docId, [...(byDoc.get(candidate.docId) ?? []), candidate]);
    const docIds = [...byDoc.keys()];
    for (let start = 0; start < docIds.length; start += READ_BATCH) {
      const batch = docIds.slice(start, start + READ_BATCH).flatMap((id) => byDoc.get(id) ?? []);
      const wanted = new Map<string, Set<string>>();
      const want = (locale: string, id: string): void => {
        const ids = wanted.get(locale) ?? new Set<string>();
        ids.add(id);
        wanted.set(locale, ids);
      };
      for (const candidate of batch) {
        want(candidate.locale, candidate.docId);
        const source = fallbackSource(candidate.locale);
        if (source !== undefined) want(source, candidate.docId);
      }
      const rows = new Map<string, Map<string, ContentDocument>>();
      for (const [locale, ids] of wanted) {
        if (deps.stopping()) return err(stopped());
        const read = await publishedRows(type, locale, [...ids]);
        if (isErr(read)) return read;
        rows.set(locale, read.value);
        await nextTurn();
      }
      for (const candidate of batch) {
        const own = rows.get(candidate.locale)?.get(candidate.docId);
        if (own === undefined) continue;
        const source = fallbackSource(candidate.locale);
        const entry = entryOf(candidate, own, source === undefined ? undefined : rows.get(source)?.get(candidate.docId));
        if (entry !== null) entries.push(entry);
      }
    }
    return ok();
  };

  const collect = async (): Promise<Result<{ candidates: number; entries: IndexEntry[] }, KestrelError>> => {
    let candidates = 0;
    const entries: IndexEntry[] = [];
    for (const type of deps.types) {
      const batched = content.model().types[type]?.kind === "multi";
      const visited = await deps.candidates(type, async (page) => {
        if (deps.stopping()) return err(stopped());
        candidates += page.length;
        return batched ? readInBatches(type, page, entries) : readOneByOne(type, page, entries);
      });
      if (isErr(visited)) return visited;
    }
    return ok({ candidates, entries: dedupeEntries(entries) });
  };

  const sectionsOf = <T>(entries: readonly IndexEntry[], map: (entry: IndexEntry) => T): Array<{ heading: string; items: T[] }> =>
    deps.types.map((type) => ({ heading: config.llms.headings[type] ?? type, items: entries.filter((e) => e.type === type).map(map) }));

  const writeRobots = async (sitemapWritten: boolean): Promise<Result<void, KestrelError>> => {
    if (config.robots === null) return ok();
    const sitemapUrl = sitemapWritten && config.siteUrl !== undefined ? `${config.siteUrl}/${SITEMAP_KEY}` : undefined;
    const put = await putIfChanged(ROBOTS_KEY, [buildRobotsTxt({ policy: config.robots.policy, extra: config.robots.extra, sitemapUrl })], ROBOTS_CONTENT_TYPE);
    return isErr(put) ? put : ok();
  };

  const sitemapPresent = async (): Promise<Result<boolean, KestrelError>> => {
    const key = `${config.prefix}${SITEMAP_KEY}`;
    const known = written.get(key);
    if (known !== undefined) return ok(known !== REMOVED);
    const listed = await blobs.list(key);
    if (isErr(listed)) return listed;
    return ok(listed.value.some((entry) => entry.key === key));
  };

  const owned = new Map<OwnedFile, string | null>();
  const own = async (file: OwnedFile, hash: string | null): Promise<Result<void, KestrelError>> => {
    if (owned.get(file) === hash) return ok();
    owned.delete(file);
    const recorded = await deps.written.write(file, hash);
    if (isErr(recorded)) return recorded;
    owned.set(file, hash);
    return ok();
  };

  const removeOwned = async (file: OwnedFile, name: string): Promise<Result<void, KestrelError>> => {
    let mine = owned.get(file);
    if (mine === undefined) {
      const read = await deps.written.read(file);
      if (isErr(read)) return read;
      mine = read.value;
      owned.set(file, mine);
    }
    if (mine === null) return ok();
    const current = await blobs.get(`${config.prefix}${name}`);
    if (isErr(current)) return current;
    if (current.value !== null && sha256(current.value) === mine) {
      const removed = await removeIfPresent(name);
      if (isErr(removed)) return removed;
    }
    return own(file, null);
  };

  const writeSitemap = async (entries: readonly IndexEntry[]): Promise<Result<boolean, KestrelError>> => {
    if (entries.length === 0) {
      const removed = await removeIfPresent(SITEMAP_KEY);
      if (isErr(removed)) return removed;
      const recorded = await own("sitemap", null);
      return isErr(recorded) ? recorded : ok(false);
    }
    const put = await putIfChanged(SITEMAP_KEY, [buildSitemapXml(sitemapUrls(entries, deps.defaultLocale))], SITEMAP_CONTENT_TYPE);
    if (isErr(put)) return put;
    const recorded = await own("sitemap", put.value);
    return isErr(recorded) ? recorded : ok(true);
  };

  const removeTurnedOff = async (): Promise<Result<void, KestrelError>> => {
    if (!(config.sitemap && config.siteUrl !== undefined)) {
      const sitemap = await removeOwned("sitemap", SITEMAP_KEY);
      if (isErr(sitemap)) return sitemap;
    }
    if (!config.llms.full) return removeOwned("llmsFull", LLMS_FULL_KEY);
    return ok();
  };

  const exportIndexes: IndexFiles["exportIndexes"] = async () => {
    if (deps.stopping()) return err(stopped());
    const sitemapOn = config.sitemap && config.siteUrl !== undefined;
    const collected = await collect();
    if (isErr(collected)) return collected;
    const { candidates, entries } = collected.value;
    if (candidates === 0) {
      const published = await deps.publishedExists();
      if (isErr(published)) return published;
      if (published.value) {
        logWarn(logger, "delivery/static: published documents exist but none has a rendered output yet; sitemap.xml and llms.txt are left as they are");
        const removed = await removeTurnedOff();
        if (isErr(removed)) return removed;
        const present = sitemapOn ? await sitemapPresent() : ok(false);
        if (isErr(present)) return present;
        const robots = await writeRobots(present.value);
        if (isErr(robots)) return robots;
        return ok({ entries: 0, skipped: true });
      }
    }
    const head = await header();
    if (isErr(head)) return head;
    const sections: LlmsSection[] = sectionsOf(entries, (e) => ({ title: e.title, url: e.url, ...(e.description === undefined ? {} : { description: e.description }) })).map((s) => ({ heading: s.heading, entries: s.items }));
    const llms = await putIfChanged(LLMS_KEY, [buildLlmsTxt({ ...head.value, sections })], LLMS_CONTENT_TYPE);
    if (isErr(llms)) return llms;
    const sitemap = sitemapOn ? await writeSitemap(entries) : ok(false);
    if (isErr(sitemap)) return sitemap;
    const removed = await removeTurnedOff();
    if (isErr(removed)) return removed;
    const robots = await writeRobots(sitemap.value);
    if (isErr(robots)) return robots;
    return ok({ entries: entries.length });
  };

  const exportLlmsFull: IndexFiles["exportLlmsFull"] = async () => {
    if (deps.stopping()) return err(stopped());
    if (!config.llms.full) return ok({ entries: 0 });
    const collected = await collect();
    if (isErr(collected)) return collected;
    const { candidates, entries } = collected.value;
    if (candidates === 0) {
      const published = await deps.publishedExists();
      if (isErr(published)) return published;
      if (published.value) return ok({ entries: 0, skipped: true });
    }
    const head = await header();
    if (isErr(head)) return head;
    let missingMain = false;
    const pages = new Map<IndexEntry, LlmsFullPage>();
    for (const entry of entries) {
      await deps.interleave();
      if (deps.stopping()) return err(stopped());
      let body = "";
      const stored = await entry.html();
      if (isErr(stored)) return stored;
      if (stored.value === null) {
        logger.error("delivery/static: rendered output missing for llms-full.txt", { type: entry.type, id: entry.docId, locale: entry.locale, path: entry.path });
      } else {
        const main = extractMain(stored.value);
        if (main === null) missingMain = true;
        body = htmlToMarkdown(main ?? bodyOf(stored.value), { ...(siteOrigin === undefined ? {} : { siteUrl: siteOrigin }), headingOffset: BODY_HEADING_OFFSET });
      }
      pages.set(entry, { title: entry.title, url: entry.url, ...(entry.description === undefined ? {} : { description: entry.description }), body });
    }
    if (missingMain) logger.info("delivery/static: rendered output without <main>, llms-full.txt uses the whole body");
    const sections: LlmsFullSection[] = sectionsOf(entries, (e) => pages.get(e)).map((s) => ({ heading: s.heading, pages: s.items.filter((p): p is LlmsFullPage => p !== undefined) }));
    const full = await putIfChanged(LLMS_FULL_KEY, llmsFullPieces({ ...head.value, sections }), LLMS_CONTENT_TYPE);
    if (isErr(full)) return full;
    const recorded = await own("llmsFull", full.value);
    if (isErr(recorded)) return recorded;
    return ok({ entries: entries.length });
  };

  return { exportIndexes, exportLlmsFull };
}
