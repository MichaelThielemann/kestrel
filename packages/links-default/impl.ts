import type { Content, FieldDefinition, FieldType } from "@michaelthielemann/kestrel-contracts/content";
import { err, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
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

const PAGE = 100;
const MAX_REDIRECTS = 5;
const URL_PATTERN = /https?:\/\/[^\s"'<>()\]]+/g;
const TEXT_TYPES = new Set<FieldType>(["text", "richtext", "json"]);

function definition(field: FieldType | FieldDefinition): FieldDefinition {
  return typeof field === "string" ? { type: field } : field;
}

export function findUrls(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.match(URL_PATTERN) ?? []) out.add(match.replace(/[.,;:!?]+$/, ""));
  } else if (Array.isArray(value)) {
    for (const v of value) findUrls(v, out);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) findUrls(v, out);
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

  const entriesOf = async (type: string, id: string): Promise<Result<Array<Omit<LinkEntry, "id">>, LinksError>> => {
    const out: Array<Omit<LinkEntry, "id">> = [];
    const seen = new Set<string>();
    for (const [field, def] of textFields(type)) {
      for (const locale of def.localized ? locales : [undefined]) {
        const doc = await content.get(type, id, locale === undefined ? {} : { locale });
        if (isErr(doc)) return doc;
        for (const url of findUrls(doc.value?.[field])) {
          const key = `${field}|${locale ?? ""}|${url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ url, fromType: type, fromId: id, field, locale: locale ?? "", ok: null, status: null, error: null, checkedAt: null });
        }
      }
    }
    return ok(out);
  };

  const extract: Links["extract"] = async (type, id) => {
    knownType(type);
    const deleted = await db.deleteMany(INDEX, { fromType: type, fromId: id });
    if (isErr(deleted)) return deleted;
    const entries = await entriesOf(type, id);
    if (isErr(entries)) return entries;
    if (entries.value.length > 0) {
      const created = await db.createMany<LinkEntry>(INDEX, entries.value);
      if (isErr(created)) return created;
    }
    return ok(entries.value.length);
  };

  const destination = async (url: string, signal: AbortSignal): Promise<{ address?: string } | { error: string }> => {
    const reason = checkable(url, config.allowPrivate);
    if (reason !== null) return { error: reason };
    if (config.allowPrivate) return {};
    const host = normalizeHostname(new URL(url).hostname);
    if (isIP(host) !== 0) return { address: host };
    const addresses = await untilAborted(resolve(host), signal);
    const [first] = addresses;
    if (first === undefined) return { error: "no address" };
    if (addresses.some(isPrivateAddress)) return { error: "private address" };
    return { address: first };
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
          const res = await fetcher(current, target.address === undefined ? init : { ...init, address: target.address });
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
      const due = now() - config.recheckAfterSeconds * 1000;
      const urls = new Set<string>();
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.findMany<LinkEntry>(INDEX, {}, { sort: { id: "asc" }, limit: PAGE, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) if (row.checkedAt === null || row.checkedAt <= due) urls.add(row.url);
        if (page.value.items.length < PAGE) break;
      }
      const queue = [...urls];
      let checked = 0;
      let broken = 0;
      let skipped = 0;
      let workerError: LinksError | null = null;
      const worker = async (): Promise<void> => {
        for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
          if (workerError !== null) return;
          const result = await probe(url);
          if (result.status === null && result.error !== null && !result.error.startsWith("timeout") && checkable(url, config.allowPrivate) !== null) skipped += 1;
          else checked += 1;
          if (!result.ok) broken += 1;
          const updated = await db.updateMany<LinkEntry>(INDEX, { url }, { ...result, checkedAt: now() });
          if (isErr(updated)) {
            workerError = updated.error;
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
      if (workerError !== null) return err(workerError);
      return ok({ urls: urls.size, checked, broken, skipped });
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
