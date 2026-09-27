import type { Content, ContentDocument, FieldDefinition, FieldType } from "@michaelthielemann/kestrel-contracts/content";
import { err, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Filter, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { isIP } from "node:net";
import { isPrivateAddress, isPrivateHost, normalizeHostname } from "./address.ts";
import { httpFetcher, systemResolver, type Fetcher, type Resolver } from "./outbound.ts";

export { isPrivateAddress, isPrivateHost } from "./address.ts";
export { httpFetcher, systemResolver, type Fetcher, type Resolver } from "./outbound.ts";

export const INDEX = "links_index";

export interface Config {
  timeoutMs: number;
  concurrency: number;
  recheckAfterSeconds: number;
  userAgent: string;
  allowPrivate: boolean;
  maxLinksPerDocument: number;
  checkBudgetSeconds: number;
}

export interface LinkEntry extends Document {
  url: string;
  fromType: string;
  fromId: string;
  field: string;
  locale: string;
  ok: boolean | null;
  status: number | null;
  error: string | null;
  checkedAt: number | null;
}

export interface CheckResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export type LinksError = KestrelError<"VALIDATION" | "NOT_FOUND" | "CONFLICT" | "TRANSIENT">;

export interface Links {
  extract(type: string, id: string): Promise<Result<number, LinksError>>;
  unextract(type: string, id: string): Promise<Result<number, LinksError>>;
  check(): Promise<Result<{ urls: number; checked: number; broken: number; skipped: number }, LinksError>>;
  report(type?: string): Promise<Result<LinkEntry[], LinksError>>;
  rebuild(): Promise<Result<{ documents: number; entries: number }, LinksError>>;
}

/** The `error` of the row that marks a document as holding more links than `maxLinksPerDocument`; its `url` is the first link left out. */
export const LINK_LIMIT_ERROR = "not checked: the document has more links than the per-document limit";

/** The longest URL, in characters, that is indexed; a longer one is left out. */
export const MAX_URL_LENGTH = 2048;

const PAGE = 100;
const MAX_REDIRECTS = 5;
const URL_PATTERN = /https?:\/\/[^\s"'<>()\]]+/g;
const TEXT_TYPES = new Set<FieldType>(["text", "richtext", "json"]);

function definition(field: FieldType | FieldDefinition): FieldDefinition {
  return typeof field === "string" ? { type: field } : field;
}

/** Collects the distinct `http(s)` URLs of at most `MAX_URL_LENGTH` characters in a string or nested JSON value, stopping once `out` holds `limit` of them. */
export function findUrls(value: unknown, out = new Set<string>(), limit = Number.POSITIVE_INFINITY): Set<string> {
  if (out.size >= limit) return out;
  if (typeof value === "string") {
    const pattern = new RegExp(URL_PATTERN.source, "g");
    for (let match = pattern.exec(value); match !== null && out.size < limit; match = pattern.exec(value)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if (url.length <= MAX_URL_LENGTH) out.add(url);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) {
      if (out.size >= limit) break;
      findUrls(v, out, limit);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      if (out.size >= limit) break;
      findUrls(v, out, limit);
    }
  }
  return out;
}

export function checkable(url: string, allowPrivate: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "unsupported scheme";
  if (!allowPrivate && isPrivateHost(parsed.hostname)) return "private address";
  return null;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function createLinksDefault(
  config: Config,
  content: Content,
  db: Persistence,
  fetcher: Fetcher = httpFetcher,
  now: () => number = Date.now,
  resolve: Resolver = systemResolver,
): Promise<Links> {
  const model = content.model();
  const locales = model.locales ?? [];
  const prepared = await db.ensureCollection(INDEX, { url: "string", fromType: "string", fromId: "string", field: "string", locale: "string", ok: "boolean", status: "number", error: "string", checkedAt: "number" });
  if (isErr(prepared)) throw new Error(`links/default: cannot prepare collection "${INDEX}": ${prepared.error.message}`);

  const textFields = (type: string): Array<[string, FieldDefinition]> =>
    Object.entries(model.types[type]?.fields ?? {})
      .map(([f, raw]) => [f, definition(raw)] as [string, FieldDefinition])
      .filter(([, def]) => TEXT_TYPES.has(def.type));
  const knownType = (type: string): void => {
    if (!(type in model.types)) throw new Error(`links/default: unknown type "${type}"`);
  };

  const entriesOf = async (type: string, id: string): Promise<Result<{ entries: Array<Omit<LinkEntry, "id">>; overflow: Omit<LinkEntry, "id"> | null }, LinksError>> => {
    const limit = config.maxLinksPerDocument;
    const entries: Array<Omit<LinkEntry, "id">> = [];
    const docs = new Map<string, ContentDocument | null>();
    for (const [field, def] of textFields(type)) {
      for (const locale of def.localized ? locales : [undefined]) {
        const key = locale ?? "";
        if (!docs.has(key)) {
          const doc = await content.get(type, id, locale === undefined ? {} : { locale });
          if (isErr(doc)) return doc;
          docs.set(key, doc.value);
        }
        for (const url of findUrls(docs.get(key)?.[field], new Set(), limit - entries.length + 1)) {
          const entry = { url, fromType: type, fromId: id, field, locale: key, ok: null, status: null, error: null, checkedAt: null };
          if (entries.length >= limit) return ok({ entries, overflow: { ...entry, ok: false, error: LINK_LIMIT_ERROR } });
          entries.push(entry);
        }
      }
    }
    return ok({ entries, overflow: null });
  };

  const extract: Links["extract"] = async (type, id) => {
    knownType(type);
    const deleted = await db.deleteMany(INDEX, { fromType: type, fromId: id });
    if (isErr(deleted)) return deleted;
    const found = await entriesOf(type, id);
    if (isErr(found)) return found;
    const { entries, overflow } = found.value;
    const rows = overflow === null ? entries : [...entries, overflow];
    if (rows.length > 0) {
      const created = await db.createMany<LinkEntry>(INDEX, rows);
      if (isErr(created)) return created;
    }
    return ok(entries.length);
  };

  const destination = async (url: string, signal: AbortSignal): Promise<{ addresses?: string[] } | { error: string }> => {
    const reason = checkable(url, config.allowPrivate);
    if (reason !== null) return { error: reason };
    if (config.allowPrivate) return {};
    const host = normalizeHostname(new URL(url).hostname);
    if (isIP(host) !== 0) return { addresses: [host] };
    const addresses = await untilAborted(resolve(host), signal);
    if (addresses.length === 0) return { error: "no address" };
    if (addresses.some(isPrivateAddress)) return { error: "private address" };
    return { addresses };
  };

  const probe = async (url: string): Promise<CheckResult> => {
    const reason = checkable(url, config.allowPrivate);
    if (reason !== null) return { ok: false, status: null, error: reason };
    const attempt = async (method: "HEAD" | "GET"): Promise<CheckResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        let current = url;
        for (let hop = 0; ; hop++) {
          const target = await destination(current, controller.signal);
          if ("error" in target) return { ok: false, status: null, error: target.error };
          const init = { method, headers: { "user-agent": config.userAgent, accept: "*/*" }, signal: controller.signal, redirect: "manual" as const };
          const res = await fetcher(current, target.addresses === undefined ? init : { ...init, addresses: target.addresses });
          const location = res.status >= 300 && res.status < 400 ? (res.headers?.get("location") ?? null) : null;
          if (location === null) return { ok: res.status < 400, status: res.status, error: null };
          if (hop >= MAX_REDIRECTS) return { ok: false, status: null, error: "too many redirects" };
          current = new URL(location, current).href;
        }
      } catch (err) {
        return { ok: false, status: null, error: controller.signal.aborted ? `timeout after ${config.timeoutMs}ms` : err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    };
    const head = await attempt("HEAD");
    return head.status === 405 || head.status === 501 ? attempt("GET") : head;
  };

  return {
    extract,
    async unextract(type, id) {
      knownType(type);
      return db.deleteMany(INDEX, { fromType: type, fromId: id });
    },
    async check() {
      const started = now();
      const due = started - config.recheckAfterSeconds * 1000;
      const deadline = started + config.checkBudgetSeconds * 1000;
      const results = new Map<string, CheckResult>();
      let checked = 0;
      let broken = 0;
      let skipped = 0;
      let last: string | null = null;
      for (;;) {
        const filter: Filter = last === null ? {} : { id: { gt: last } };
        const page = await db.findMany<LinkEntry>(INDEX, filter, { sort: { id: "asc" }, limit: PAGE });
        if (isErr(page)) return page;
        const rows = page.value.items.filter((row) => row.error !== LINK_LIMIT_ERROR && (row.checkedAt === null || row.checkedAt <= due));
        const queue = [...new Set(rows.map((row) => row.url))].filter((url) => !results.has(url));
        const worker = async (): Promise<void> => {
          for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
            if (now() >= deadline) return;
            const result = await probe(url);
            results.set(url, result);
            if (result.status === null && result.error !== null && !result.error.startsWith("timeout") && checkable(url, config.allowPrivate) !== null) skipped += 1;
            else checked += 1;
            if (!result.ok) broken += 1;
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
        for (const row of rows) {
          const result = results.get(row.url);
          if (result === undefined) continue;
          const updated = await db.updateOne<LinkEntry>(INDEX, row.id, { ...result, checkedAt: now() });
          if (isErr(updated) && updated.error.code !== "NOT_FOUND") return err(updated.error);
        }
        const tail = page.value.items.at(-1);
        if (tail === undefined || page.value.items.length < PAGE || now() >= deadline) break;
        last = tail.id;
        await new Promise<void>((resume) => setImmediate(resume));
      }
      return ok({ urls: results.size, checked, broken, skipped });
    },
    async report(type) {
      if (type !== undefined) knownType(type);
      const page = await db.findMany<LinkEntry>(INDEX, type === undefined ? { ok: false } : { ok: false, fromType: type }, { sort: { fromType: "asc", fromId: "asc" } });
      if (isErr(page)) return page;
      return ok(page.value.items);
    },
    async rebuild() {
      const deleted = await db.deleteMany(INDEX, {});
      if (isErr(deleted)) return deleted;
      let documents = 0;
      let entries = 0;
      for (const type of Object.keys(model.types)) {
        if (textFields(type).length === 0) continue;
        for (let offset = 0; ; offset += PAGE) {
          const page = await content.list(type, {}, { limit: PAGE, offset });
          if (isErr(page)) return page;
          for (const doc of page.value.items) {
            documents += 1;
            const count = await extract(type, doc.id);
            if (isErr(count)) return count;
            entries += count.value;
          }
          if (page.value.items.length < PAGE) break;
        }
      }
      return ok({ documents, entries });
    },
  };
}
