import type { Document } from "@michaelthielemann/kestrel-contracts/persistence";
import { formatPath, reservedMatch, tailOf, type Mounts, type Move, type RoutesConfig } from "./routes.ts";

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
  ref: string | null;
}

/** What `content@1` says about one document in one locale, before claims are settled. */
export interface Base {
  type: string;
  docId: string;
  locale: string;
  own: string | null;
  slug: string | null;
  live: boolean;
  parent: string | null;
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
  message?: string;
}

export const DOC_SCHEMA = { type: "string", docId: "string", locale: "string", parent: "string", own: "string", tail: "string", strong: "boolean", live: "boolean", valid: "boolean", createdAt: "number", updatedAt: "number" } as const;
export const CLAIM_SCHEMA = { locale: "string", tail: "string", strength: "string", type: "string", docId: "string" } as const;
export const RUN_SCHEMA = { runId: "string", seq: "number", touched: "json", moves: "json", announced: "boolean", at: "number" } as const;
export const META_SCHEMA = { hash: "string", value: "number", ref: "string" } as const;

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

/** The document whose tail prefixes `base`'s: its parent, else its type's mount page, else none (top level). */
export function prefixSource(f: Formatter, base: Pick<Base, "type" | "parent">, mounts: Mounts): string | undefined {
  if (base.parent !== null) return docKey(base.type, base.parent);
  const page = f.config.routes[base.type]?.mount === true ? mounts[base.type] : undefined;
  return page === undefined || page === null ? undefined : docKey(f.config.mountTarget, page);
}

/** The base a stored row stands for, so a save can recompute every other document without reading content. */
export function baseOfRows(rows: readonly DocRow[]): Base[] {
  return rows.map((row) => ({ type: row.type, docId: row.docId, locale: row.locale, own: row.own, slug: row.own, live: row.live, parent: row.parent, createdAt: row.createdAt, updatedAt: row.updatedAt }));
}

interface Claim {
  strong?: DocRow;
  weak?: DocRow;
}

/**
 * Every row the bases give. A document's tail is its prefix source's tail plus its slug. A tail already held keeps
 * its holder and an unheld one goes to its oldest claimant; every other claimant loses its claim. A row is valid when
 * it holds a strong claim (a slug of its own in its locale) and it is placed: it holds its tail, and so does every
 * document its prefix comes from, whatever their publication or their claims' strength. A weak claim only places the
 * rows below it and is never valid itself.
 */
export function derive(f: Formatter, bases: readonly Base[], current: readonly DocRow[], mounts: Mounts): { rows: DocRow[]; conflicts: RebuildConflict[] } {
  const byRow = new Map<string, Base>();
  for (const base of bases) if (f.config.routes[base.type]) byRow.set(rowId(base.type, base.docId, base.locale), base);
  const tails = new Map<string, string | null>();
  const visiting = new Set<string>();
  const tailFor = (id: string): string | null => {
    const known = tails.get(id);
    if (known !== undefined) return known;
    const base = byRow.get(id);
    if (!base || base.slug === null) return null;
    const route = f.config.routes[base.type]!;
    const source = prefixSource(f, base, mounts);
    let tail: string | null;
    if (source === undefined) tail = tailOf(base.slug, route);
    else if (visiting.has(id)) tail = null;
    else {
      visiting.add(id);
      const prefix = tailFor(`${source}/${base.locale}`);
      visiting.delete(id);
      tail = prefix === null ? null : prefix === "" ? base.slug : `${prefix}/${base.slug}`;
    }
    tails.set(id, tail);
    return tail;
  };

  const holders = new Map<string, string>();
  for (const row of current) if (row.tail !== null) holders.set(`${claimKey(row.locale, row.tail)}\u0000${row.strong ? "s" : "w"}`, row.id);
  const rows = new Map<string, DocRow>();
  const groups = new Map<string, { strong: DocRow[]; weak: DocRow[] }>();
  const conflicts: RebuildConflict[] = [];
  for (const [id, base] of byRow) {
    const tail = tailFor(id);
    const row: DocRow = { id, type: base.type, docId: base.docId, locale: base.locale, parent: base.parent, own: base.own, tail, strong: tail !== null && base.own !== null, live: base.live, valid: false, createdAt: base.createdAt, updatedAt: base.updatedAt };
    rows.set(id, row);
    if (tail === null) continue;
    const bad = violation(f, tail, row.locale);
    if (bad) {
      conflicts.push({ path: pathOfTail(f, tail, row.locale), locale: row.locale, winner: null, losers: [{ type: row.type, id: row.docId }], reason: bad.reason, message: bad.message });
      row.tail = null;
      row.strong = false;
      continue;
    }
    const key = claimKey(row.locale, tail);
    const group = groups.get(key) ?? { strong: [], weak: [] };
    (row.strong ? group.strong : group.weak).push(row);
    groups.set(key, group);
  }
  const claims = new Map<string, Claim>();
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
      }
    }
    return winner;
  };
  for (const [key, group] of groups) {
    const claim: Claim = {};
    const strong = pick(group.strong, "s", key);
    const weak = pick(group.weak, "w", key);
    if (strong) claim.strong = strong;
    if (weak) claim.weak = weak;
    claims.set(key, claim);
  }

  const placement = new Map<string, boolean>();
  const placed = (row: DocRow | undefined): boolean => {
    if (row === undefined || row.tail === null) return false;
    const known = placement.get(row.id);
    if (known !== undefined) return known;
    placement.set(row.id, false);
    const source = prefixSource(f, row, mounts);
    const result = source === undefined || placed(rows.get(`${source}/${row.locale}`));
    placement.set(row.id, result);
    return result;
  };
  const validFor = (row: DocRow): boolean => {
    if (row.tail === null) return false;
    const claim = claims.get(claimKey(row.locale, row.tail)) ?? {};
    return row.strong && claim.strong === row && placed(row);
  };
  for (const row of rows.values()) row.valid = validFor(row);
  return { rows: [...rows.values()], conflicts };
}

/** The in-memory mirror of the committed rows, patched only from committed state. */
export class PathTable {
  mounts: Mounts = {};
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
