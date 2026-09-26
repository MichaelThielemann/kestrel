import type { Document } from "@michaelthielemann/kestrel-contracts/persistence";
import { formatPath, reservedMatch, tailOf, type Move, type Route, type RoutesConfig } from "./routes.ts";

export const DOCS = "site_docs";
export const PATHS = "site_paths";
export const RUNS = "site_runs";
export const META = "site_meta";
export const COLLECTIONS = [DOCS, PATHS, RUNS, META] as const;

/** The stored path state of one document in one locale. */
export interface DocRow extends Document {
  type: string;
  docId: string;
  locale: string;
  parent: string | null;
  own: string | null;
  tail: string | null;
  strong: boolean;
  live: boolean;
  valid: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One claim of a `(locale, tail)`: at most one strong row per tail, any number of weak ones. */
export interface ClaimRow extends Document {
  locale: string;
  tail: string;
  strength: "s" | "w";
  type: string;
  docId: string;
}

/** The outbox row of one run that changed path state. */
export interface RunRow extends Document {
  runId: string | null;
  seq: number;
  touched: string[];
  moves: Move[];
  announced: boolean;
  at: number;
}

export interface MetaRow extends Document {
  hash: string | null;
  value: number | null;
}

/** What `content@1` says about one document in one locale, before claims are settled. */
export interface Base {
  type: string;
  docId: string;
  locale: string;
  own: string | null;
  slug: string | null;
  live: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A tail two or more documents want, or one no document may take, as a rebuild reports it. */
export interface RebuildConflict {
  path: string;
  locale: string;
  winner: { type: string; id: string } | null;
  losers: Array<{ type: string; id: string }>;
  reason: "taken" | "reserved" | "locale";
}

export const DOC_SCHEMA = { type: "string", docId: "string", locale: "string", parent: "string", own: "string", tail: "string", strong: "boolean", live: "boolean", valid: "boolean", createdAt: "number", updatedAt: "number" } as const;
export const CLAIM_SCHEMA = { locale: "string", tail: "string", strength: "string", type: "string", docId: "string" } as const;
export const RUN_SCHEMA = { runId: "string", seq: "number", touched: "json", moves: "json", announced: "boolean", at: "number" } as const;
export const META_SCHEMA = { hash: "string", value: "number" } as const;

export const docKey = (type: string, docId: string): string => `${type}/${docId}`;
export const rowId = (type: string, docId: string, locale: string): string => `${type}/${docId}/${locale}`;
export const claimId = (locale: string, tail: string, strength: "s" | "w", docId: string): string => (strength === "s" ? `${locale}/${tail}/s` : `${locale}/${tail}/w/${docId}`);
const claimKey = (locale: string, tail: string): string => `${locale}\u0000${tail}`;

export function claimOf(row: DocRow): ClaimRow | null {
  if (row.tail === null) return null;
  const strength = row.strong ? "s" : "w";
  return { id: claimId(row.locale, row.tail, strength, row.docId), locale: row.locale, tail: row.tail, strength, type: row.type, docId: row.docId };
}

export function sameRow(a: DocRow, b: DocRow): boolean {
  return a.parent === b.parent && a.own === b.own && a.tail === b.tail && a.strong === b.strong && a.live === b.live && a.valid === b.valid && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
}

export function sameClaim(a: ClaimRow, b: ClaimRow): boolean {
  return a.locale === b.locale && a.tail === b.tail && a.strength === b.strength && a.type === b.type && a.docId === b.docId;
}

export interface Formatter {
  defaultLocale: string;
  locales: readonly string[];
  config: RoutesConfig;
}

export function pathOfTail(f: Formatter, tail: string, locale: string, prefixPrimary = f.config.prefixPrimary): string {
  return formatPath(tail, locale, f.defaultLocale, prefixPrimary);
}

/** The path a row is reachable at, in the configured form, or `null`. */
export function reachablePath(f: Formatter, row: DocRow | undefined | null): string | null {
  if (!row || row.tail === null || !row.live || !row.valid) return null;
  return pathOfTail(f, row.tail, row.locale);
}

/** Why a tail may not be claimed in a locale, or `null`. */
export function violation(f: Formatter, tail: string, locale: string): { reason: "reserved" | "locale"; message: string } | null {
  const path = pathOfTail(f, tail, locale);
  const reserved = reservedMatch(path, f.config.reservedPaths);
  if (reserved !== undefined) return { reason: "reserved", message: `the path ${path} lies under the reserved path ${reserved}` };
  const first = tail.split("/")[0] ?? "";
  if (first !== "" && f.locales.includes(first)) return { reason: "locale", message: `"${first}" is a locale code and cannot start a path` };
  return null;
}

export function baseTail(base: Base, route: Route): string | null {
  return base.slug === null ? null : tailOf(base.slug, route);
}

export function baseRow(base: Base, route: Route): DocRow {
  const tail = baseTail(base, route);
  return {
    id: rowId(base.type, base.docId, base.locale),
    type: base.type,
    docId: base.docId,
    locale: base.locale,
    parent: null,
    own: base.own,
    tail,
    strong: tail !== null && base.own !== null,
    live: base.live,
    valid: tail !== null,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  };
}

/**
 * The rows a full rebuild settles on: a tail already held keeps its holder, an unheld tail goes to its oldest
 * claimant, and every other claimant of it loses its claim. A weak claim is valid unless a live strong claim holds
 * the same tail.
 */
export function settle(f: Formatter, bases: readonly Base[], current: readonly DocRow[]): { rows: DocRow[]; conflicts: RebuildConflict[] } {
  const holders = new Map<string, string>();
  for (const row of current) if (row.tail !== null) holders.set(`${claimKey(row.locale, row.tail)}\u0000${row.strong ? "s" : "w"}`, row.id);
  const rows = new Map<string, DocRow>();
  const groups = new Map<string, { strong: DocRow[]; weak: DocRow[] }>();
  const conflicts: RebuildConflict[] = [];
  for (const base of bases) {
    const route = f.config.routes[base.type];
    if (!route) continue;
    const row = baseRow(base, route);
    rows.set(row.id, row);
    if (row.tail === null) continue;
    const bad = violation(f, row.tail, row.locale);
    if (bad) {
      conflicts.push({ path: pathOfTail(f, row.tail, row.locale), locale: row.locale, winner: null, losers: [{ type: row.type, id: row.docId }], reason: bad.reason });
      row.tail = null;
      row.strong = false;
      row.valid = false;
      continue;
    }
    const key = claimKey(row.locale, row.tail);
    const group = groups.get(key) ?? { strong: [], weak: [] };
    (row.strong ? group.strong : group.weak).push(row);
    groups.set(key, group);
  }
  const pick = (claimants: DocRow[], strength: "s" | "w", key: string): DocRow | undefined => {
    if (claimants.length === 0) return undefined;
    const held = holders.get(`${key}\u0000${strength}`);
    const winner = claimants.find((r) => r.id === held) ?? [...claimants].sort((a, b) => a.createdAt - b.createdAt || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))[0]!;
    const losers = claimants.filter((r) => r !== winner);
    if (losers.length > 0) {
      conflicts.push({ path: pathOfTail(f, winner.tail ?? "", winner.locale), locale: winner.locale, winner: { type: winner.type, id: winner.docId }, losers: losers.map((r) => ({ type: r.type, id: r.docId })), reason: "taken" });
      for (const loser of losers) {
        loser.tail = null;
        loser.strong = false;
        loser.valid = false;
      }
    }
    return winner;
  };
  for (const [key, group] of groups) {
    const strong = pick(group.strong, "s", key);
    const weak = pick(group.weak, "w", key);
    if (weak) weak.valid = !(strong?.live ?? false);
  }
  return { rows: [...rows.values()], conflicts };
}

/** The in-memory mirror of the committed rows, patched only from committed state. */
export class PathTable {
  private readonly rows = new Map<string, DocRow>();
  private readonly byDoc = new Map<string, Set<string>>();
  private readonly claims = new Map<string, { strong: string | null; weak: Set<string> }>();

  load(rows: readonly DocRow[]): void {
    this.rows.clear();
    this.byDoc.clear();
    this.claims.clear();
    for (const row of rows) this.add(row);
  }

  replace(keys: Iterable<string>, rows: readonly DocRow[]): void {
    for (const key of keys) {
      for (const id of this.byDoc.get(key) ?? []) this.remove(id);
      this.byDoc.delete(key);
    }
    for (const row of rows) this.add(row);
  }

  row(type: string, docId: string, locale: string): DocRow | undefined {
    return this.rows.get(rowId(type, docId, locale));
  }

  rowsOf(type: string, docId: string): DocRow[] {
    return [...(this.byDoc.get(docKey(type, docId)) ?? [])].map((id) => this.rows.get(id)).filter((r): r is DocRow => r !== undefined);
  }

  claim(locale: string, tail: string): { strong: DocRow | undefined; weak: DocRow[] } {
    const entry = this.claims.get(claimKey(locale, tail));
    if (!entry) return { strong: undefined, weak: [] };
    return {
      strong: entry.strong === null ? undefined : this.rows.get(entry.strong),
      weak: [...entry.weak].map((id) => this.rows.get(id)).filter((r): r is DocRow => r !== undefined),
    };
  }

  private add(row: DocRow): void {
    this.remove(row.id);
    this.rows.set(row.id, row);
    const key = docKey(row.type, row.docId);
    const ids = this.byDoc.get(key) ?? new Set<string>();
    ids.add(row.id);
    this.byDoc.set(key, ids);
    if (row.tail === null) return;
    const ck = claimKey(row.locale, row.tail);
    const entry = this.claims.get(ck) ?? { strong: null, weak: new Set<string>() };
    if (row.strong) entry.strong = row.id;
    else entry.weak.add(row.id);
    this.claims.set(ck, entry);
  }

  private remove(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    if (row.tail === null) return;
    const ck = claimKey(row.locale, row.tail);
    const entry = this.claims.get(ck);
    if (!entry) return;
    if (entry.strong === id) entry.strong = null;
    entry.weak.delete(id);
    if (entry.strong === null && entry.weak.size === 0) this.claims.delete(ck);
  }
}
