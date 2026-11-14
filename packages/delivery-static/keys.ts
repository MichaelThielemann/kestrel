import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";

const PLAIN = /^[A-Za-z0-9._-]$/;
const SCAN_PAGE = 200;

/** One id segment: letters, digits, `.`, `_` and `-` stay as they are, every other byte of its UTF8 encoding is percent-encoded in upper-case hex, so `/`, `*` and `?` never occur inside a segment. */
export function encodeSegment(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && PLAIN.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function localeSegment(locale: string): string {
  return locale === "" ? "-" : encodeSegment(locale);
}

/** The deterministic id a new status row of this output is created with. */
export function statusIdOf(type: string, docId: string, locale: string): string {
  return `${encodeSegment(type)}/${encodeSegment(docId)}/${localeSegment(locale)}`;
}

/** The id of the dependency set one render of this output writes. */
export function setIdOf(type: string, docId: string, locale: string, renderId: string): string {
  return `${statusIdOf(type, docId, locale)}/${encodeSegment(renderId)}`;
}

export type DependencyKind = "document" | "type" | "query" | "path";

export interface OutputRef {
  type: string;
  docId: string;
  locale: string;
}

/** The segment every dependency row of `depType`/`depId` starts with; `*` for `type` rows and `?` for `query` rows. */
export function dependencyPrefix(kind: DependencyKind, depType: string, depId: string | null): string {
  const id = kind === "type" ? "*" : kind === "query" ? "?" : encodeSegment(depId ?? "");
  return `${encodeSegment(depType)}/${id}/`;
}

export function dependencyRowId(dep: { kind: DependencyKind; depType: string; depId: string | null }, output: OutputRef, renderId: string, n: number): string {
  return `${dependencyPrefix(dep.kind, dep.depType, dep.depId)}${dep.kind}/${encodeSegment(output.type)}/${encodeSegment(output.docId)}/${localeSegment(output.locale)}/${encodeSegment(renderId)}/${n}`;
}

/**
 * Every row of `collection` whose id starts with `prefix`, in id order, with one operator per condition:
 * `id >= prefix` sorted by id, stopping at the first id outside the prefix, continued by `id > last` while a page
 * comes back full. The ids under one prefix form one contiguous block in binary order.
 */
export async function scan<T extends Document>(db: Persistence, collection: string, prefix: string): Promise<Result<T[], PersistenceError>> {
  const out: T[] = [];
  let filter: Record<string, unknown> = { id: { gte: prefix } };
  for (;;) {
    const page = await db.findMany<T>(collection, filter, { sort: { id: "asc" }, limit: SCAN_PAGE, withTotal: false });
    if (isErr(page)) return page;
    for (const row of page.value.items) {
      if (!row.id.startsWith(prefix)) return ok(out);
      out.push(row);
    }
    const last = page.value.items.at(-1);
    if (page.value.items.length < SCAN_PAGE || last === undefined) return ok(out);
    filter = { id: { gt: last.id } };
  }
}
