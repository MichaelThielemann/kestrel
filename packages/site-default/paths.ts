import { randomUUID } from "node:crypto";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { satisfiesFilter } from "@michaelthielemann/kestrel-contracts/helpers/content-locale";
import { err, failure, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Filter, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { defaultLocaleKey, localeKeys, PATHS_MOVED, routesHash, tailOf, type Mounts, type Move, type Route, type RoutesConfig } from "./routes.ts";
import {
  baseOfRows,
  derive,
  prefixSource,
  claimOf,
  CLAIM_SCHEMA,
  DOCS,
  DOC_SCHEMA,
  docKey,
  META,
  META_SCHEMA,
  PathTable,
  PATHS,
  pathOfTail,
  reachablePath,
  rowId,
  RUNS,
  RUN_SCHEMA,
  sameClaim,
  sameRow,
  violation,
  type Base,
  type ClaimRow,
  type DocRow,
  type Formatter,
  type MetaRow,
  type RebuildConflict,
  type RunRow,
} from "./table.ts";

export type PathsError = KestrelError<"CONFLICT" | "VALIDATION" | "TRANSIENT">;

/** One document a path conflict names: the occupant, and the document of the save that collides with it. */
export interface PathConflict {
  path: string;
  locale: string;
  type: string;
  id: string;
  label: string;
  moving: { type: string; id: string };
}

/** Everything a rebuild computes outside the write group. */
export interface RebuildPlan {
  baseSeq: number;
  previous: boolean;
  bases: Base[];
  docs: DocRow[];
  claims: ClaimRow[];
  mounts: Mounts;
}

export interface RebuildReport {
  indexed: number;
  conflicts: RebuildConflict[];
}

export interface PathPreview {
  path: string;
  /** Whether the path is free and valid and the stored document passes its route's `liveWhen` in the locale; `false` for a document not saved yet. */
  reachable: boolean;
  /** Why the path itself cannot be served (invalid, taken, or a page above without a slug), `null` when it can; never names the document's own status. */
  reason: string | null;
  conflict: Omit<PathConflict, "moving"> | null;
  shadows: Array<{ type: string; id: string; label: string; path: string }>;
  exposesParentSlug: { type: string; id: string; label: string } | null;
}

export interface TreeNode {
  id: string;
  parent: string | null;
  label: string;
  paths: Record<string, string | null>;
  /** Per locale: whether the document passes its route's `liveWhen` there. */
  live: Record<string, boolean>;
}

export interface SitePaths {
  readonly config: RoutesConfig;
  readonly table: PathTable;
  readonly format: Formatter;
  route(type: string): Route | undefined;
  /** Locale key → path of `type/id`, reachable paths only or every valid path (drafts included). */
  pathsOf(type: string, id: string, mode: "reachable" | "valid"): Record<string, string | null>;
  /**
   * Recomputes `type/id` and every document whose path depends on it, inside the caller's atomic group. `locale` is the
   * locale the write changed (the default locale when absent): a `VALIDATION` error on the slug field refuses the save
   * when the document passes `liveWhen` there, has a translation there and no slug of its own.
   */
  index(type: string, id: string, runId: string, locale?: string): Promise<Result<{ moves: Move[] }, PathsError>>;
  /** Patches memory from committed rows and raises the run's moves; never fails. */
  announce(runId: string | null): Promise<void>;
  resume(): Promise<Result<{ announced: number; pruned: number }, PathsError>>;
  planRebuild(): Promise<Result<RebuildPlan, PathsError>>;
  applyRebuild(plan: RebuildPlan, runId: string | null): Promise<Result<RebuildReport, PathsError>>;
  preview(type: string, input: { id?: string; locale?: string; slug: string; parent?: string | null }): Promise<Result<PathPreview, PathsError>>;
  /** Re-reads the mount assignment, validates it and moves every document of each type whose mount changed, inside the caller's atomic group. */
  indexMounts(runId: string): Promise<Result<{ moves: Move[] }, PathsError>>;
  /** Every document of the mount target type with its parent, label and valid paths. */
  tree(type: string): Promise<Result<TreeNode[], PathsError>>;
}

export interface SitePathsDeps {
  content: Content;
  db: Persistence;
  events: Events | undefined;
  logger: Logger;
  now?: () => number;
  bootedAt?: number;
}

const CHUNK = 500;
const PAGE = 200;
const ANNOUNCE_GRACE_MS = 5_000;
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class Abort extends Error {
  readonly error: PathsError;

  constructor(error: PathsError) {
    super(error.message);
    this.error = error;
  }
}

function need<T>(result: Result<T, KestrelError>, from: string): T {
  if (result.ok) return result.value;
  if (result.error.code === "TRANSIENT") throw new Abort(failure("TRANSIENT", result.error.message, { cause: result.error }));
  throw new Error(`site/default: unexpected ${from} error ${result.error.code}: ${result.error.message}`);
}

async function guarded<T>(body: () => Promise<T>): Promise<Result<T, PathsError>> {
  try {
    return ok(await body());
  } catch (e) {
    if (e instanceof Abort) return err(e.error);
    throw e;
  }
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

function slugValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parentOf(doc: ContentDocument, route: Route): string | null {
  if (route.parentField === null) return null;
  const value = doc[route.parentField];
  return typeof value === "string" && value !== "" ? value : null;
}

function label(doc: ContentDocument | null, route: Route, fallback: string): string {
  const value = doc?.[route.labelField];
  return typeof value === "string" && value !== "" ? value : fallback;
}

export async function createSitePaths(config: RoutesConfig, deps: SitePathsDeps): Promise<SitePaths> {
  const { content, db, events, logger } = deps;
  const now = deps.now ?? Date.now;
  const bootedAt = deps.bootedAt ?? now();
  const model = content.model();
  const locales = localeKeys(model);
  const defaultLocale = defaultLocaleKey(model);
  const format: Formatter = { defaultLocale, locales: model.locales ?? [], config };
  const table = new PathTable();
  const inFlight = new Set<string>();
  const routeOf = (type: string): Route => {
    const route = config.routes[type];
    if (!route) throw new Error(`site/default: "${type}" is not a routed type`);
    return route;
  };
  const localeOption = (locale: string) => (locale === "" ? {} : { locale });

  async function all<T extends Document>(collection: string, filter: Filter): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += CHUNK) {
      const page = need(await db.findMany<T>(collection, filter, { sort: { id: "asc" }, limit: CHUNK, offset }), "persistence@1");
      out.push(...page.items);
      if (page.items.length < CHUNK) return out;
    }
  }

  async function byIds<T extends Document>(collection: string, ids: readonly string[]): Promise<T[]> {
    const out: T[] = [];
    for (const part of chunks(ids)) out.push(...need(await db.findMany<T>(collection, { id: { in: part } }, { limit: part.length }), "persistence@1").items);
    return out;
  }

  async function replaceRows<T extends Document>(collection: string, removed: readonly string[], created: readonly T[]): Promise<void> {
    for (const part of chunks(removed)) need(await db.deleteMany(collection, { id: { in: part } }), "persistence@1");
    for (const part of chunks(created)) {
      const written = await db.createMany<T>(collection, part);
      if (!written.ok && written.error.code === "CONFLICT") throw new Abort(failure("CONFLICT", "site/default: a path was claimed concurrently; save again", { cause: written.error }));
      need(written, "persistence@1");
    }
  }

  async function readSeq(): Promise<number> {
    const row = need(await db.findOne<MetaRow>(META, { id: "seq" }), "persistence@1");
    return row?.value ?? 0;
  }

  async function takeSeq(): Promise<number> {
    const row = need(await db.findOne<MetaRow>(META, { id: "seq" }), "persistence@1");
    const value = (row?.value ?? 0) + 1;
    if (row) need(await db.updateOne<MetaRow>(META, "seq", { value }), "persistence@1");
    else need(await db.createOne<MetaRow>(META, { id: "seq", hash: null, value, ref: null }), "persistence@1");
    return value;
  }

  async function writeRun(runId: string | null, touched: readonly string[], moves: readonly Move[], seq: number): Promise<void> {
    const id = runId ?? randomUUID();
    const existing = runId === null ? null : need(await db.findOne<RunRow>(RUNS, { id }), "persistence@1");
    if (!existing) {
      need(await db.createOne<RunRow>(RUNS, { id, runId, seq, touched: [...touched], moves: [...moves], announced: false, at: now() }), "persistence@1");
      return;
    }
    const merged = new Map<string, Move>();
    for (const move of [...existing.moves, ...moves]) {
      const key = rowId(move.type, move.id, move.locale);
      const before = merged.get(key);
      merged.set(key, { ...move, from: before ? before.from : move.from, seq });
    }
    const combined = [...merged.values()].filter((m) => m.from !== m.to);
    need(await db.updateOne<RunRow>(RUNS, id, { seq, touched: [...new Set([...existing.touched, ...touched])], moves: combined, announced: false }), "persistence@1");
  }

  async function readBases(type: string, id: string): Promise<Base[] | null> {
    const route = routeOf(type);
    const own = new Map<string, string | null>();
    let stamp: { createdAt: number; updatedAt: number; parent: string | null } | null = null;
    for (const locale of locales) {
      const doc = need(await content.get(type, id, localeOption(locale)), "content@1");
      if (!doc) return null;
      stamp = { createdAt: doc.createdAt, updatedAt: doc.updatedAt, parent: parentOf(doc, route) };
      own.set(locale, slugValue(doc[route.slugField]));
    }
    if (!stamp) return null;
    const bases: Base[] = [];
    for (const locale of locales) {
      const live = need(await satisfiesFilter(content, type, id, locale === "" ? undefined : locale, route.liveWhen), "content@1");
      const ownSlug = own.get(locale) ?? null;
      bases.push({ type, docId: id, locale, own: ownSlug, slug: ownSlug, live, ...stamp });
    }
    return bases;
  }

  async function readAllBases(): Promise<Base[]> {
    const bases: Base[] = [];
    for (const [type, route] of Object.entries(config.routes)) {
      const own = new Map<string, Map<string, string | null>>();
      const stamps = new Map<string, { createdAt: number; updatedAt: number; parent: string | null }>();
      const live = new Map<string, Set<string>>();
      for (const locale of locales) {
        const slugs = new Map<string, string | null>();
        for (let offset = 0; ; offset += PAGE) {
          const page = need(await content.list(type, {}, { ...localeOption(locale), sort: { id: "asc" }, limit: PAGE, offset }), "content@1");
          for (const doc of page.items) {
            slugs.set(doc.id, slugValue(doc[route.slugField]));
            stamps.set(doc.id, { createdAt: doc.createdAt, updatedAt: doc.updatedAt, parent: parentOf(doc, route) });
          }
          if (page.items.length < PAGE) break;
        }
        own.set(locale, slugs);
        const liveIds = new Set<string>();
        if (Object.keys(route.liveWhen).length === 0) for (const id of slugs.keys()) liveIds.add(id);
        else {
          for (let offset = 0; ; offset += PAGE) {
            const page = need(await content.list(type, route.liveWhen, { ...localeOption(locale), sort: { id: "asc" }, limit: PAGE, offset }), "content@1");
            for (const doc of page.items) liveIds.add(doc.id);
            if (page.items.length < PAGE) break;
          }
        }
        live.set(locale, liveIds);
      }
      for (const [id, stamp] of stamps) {
        for (const locale of locales) {
          const ownSlug = own.get(locale)?.get(id) ?? null;
          bases.push({ type, docId: id, locale, own: ownSlug, slug: ownSlug, live: live.get(locale)?.has(id) ?? false, ...stamp });
        }
      }
    }
    return bases;
  }

  async function labelOf(type: string, id: string, locale: string): Promise<string> {
    const route = config.routes[type];
    if (!route) return id;
    const doc = need(await content.get(type, id, { ...localeOption(locale), fallback: true }), "content@1");
    return label(doc, route, id);
  }

  async function patchMemory(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const ids = keys.flatMap((key) => locales.map((locale) => `${key}/${locale}`));
    table.replace(keys, await byIds<DocRow>(DOCS, ids));
    table.mounts = await readMounts();
  }

  async function readMounts(): Promise<Mounts> {
    const out: Mounts = {};
    for (const [type, route] of Object.entries(config.routes)) {
      if (!route.mount) continue;
      out[type] = need(await db.findOne<MetaRow>(META, { id: `mount:${type}` }), "persistence@1")?.ref ?? null;
    }
    return out;
  }

  async function writeMounts(mounts: Mounts): Promise<void> {
    for (const [type, ref] of Object.entries(mounts)) {
      const id = `mount:${type}`;
      const row = need(await db.findOne<MetaRow>(META, { id }), "persistence@1");
      if (row) {
        if (row.ref !== ref) need(await db.updateOne<MetaRow>(META, id, { ref }), "persistence@1");
      } else need(await db.createOne<MetaRow>(META, { id, hash: null, value: null, ref }), "persistence@1");
    }
  }

  async function storedMounts(): Promise<Record<string, unknown>> {
    if (!config.mounts) return {};
    const doc = need(await content.get(config.mounts.type), "content@1");
    const value = doc?.[config.mounts.field];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  }

  function contentMounts(raw: Record<string, unknown>): Mounts {
    const out: Mounts = {};
    for (const [type, route] of Object.entries(config.routes)) {
      if (!route.mount) continue;
      const value = raw[type];
      out[type] = typeof value === "string" && value !== "" ? value : null;
    }
    return out;
  }

  interface Diff {
    changed: Array<{ before: DocRow | null; after: DocRow | null }>;
    removedClaims: string[];
    createdClaims: ClaimRow[];
  }

  function diff(current: readonly DocRow[], currentClaims: readonly ClaimRow[], desired: readonly DocRow[]): Diff {
    const before = new Map(current.map((r) => [r.id, r]));
    const after = new Map(desired.map((r) => [r.id, r]));
    const changed: Diff["changed"] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(id) ?? null;
      const a = after.get(id) ?? null;
      if (b && a && sameRow(b, a)) continue;
      changed.push({ before: b, after: a });
    }
    const had = new Map(currentClaims.map((c) => [c.id, c]));
    const wanted = new Map(desired.flatMap((r) => {
      const c = claimOf(r);
      return c ? [[c.id, c] as const] : [];
    }));
    return {
      changed,
      removedClaims: [...had.keys()].filter((id) => !wanted.has(id) || !sameClaim(had.get(id)!, wanted.get(id)!)),
      createdClaims: [...wanted.values()].filter((c) => !had.has(c.id) || !sameClaim(had.get(c.id)!, c)),
    };
  }

  async function apply(change: Diff, runId: string | null, recordMoves: boolean): Promise<Move[]> {
    await replaceRows(PATHS, change.removedClaims, change.createdClaims);
    await replaceRows(
      DOCS,
      change.changed.flatMap((c) => (c.before ? [c.before.id] : [])),
      change.changed.flatMap((c) => (c.after ? [c.after] : [])),
    );
    const seq = await takeSeq();
    const moves: Move[] = [];
    const touched = new Set<string>();
    for (const { before, after } of change.changed) {
      const ref = (after ?? before)!;
      touched.add(docKey(ref.type, ref.docId));
      const from = reachablePath(format, before);
      const to = reachablePath(format, after);
      if (recordMoves && from !== to) moves.push({ type: ref.type, id: ref.docId, locale: ref.locale, from, to, seq });
    }
    await writeRun(runId, [...touched], moves, seq);
    return moves;
  }

  function fieldError(field: string, message: string): Abort {
    return new Abort(failure("VALIDATION", message, { details: { fields: [{ field, message }] } }));
  }

  function descendants(bases: readonly Base[], mounts: Mounts, roots: readonly string[]): Set<string> {
    const children = new Map<string, Set<string>>();
    for (const base of bases) {
      const source = prefixSource(format, base, mounts);
      if (source === undefined) continue;
      const key = docKey(base.type, base.docId);
      children.set(source, (children.get(source) ?? new Set<string>()).add(key));
    }
    const out = new Set<string>(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (out.has(child)) continue;
        out.add(child);
        queue.push(child);
      }
    }
    return out;
  }

  async function ancestorWithoutSlug(rows: ReadonlyMap<string, DocRow>, row: DocRow, mounts: Mounts): Promise<string> {
    for (let at: DocRow | undefined = row, guard = 0; at && guard <= config.maxDepth; guard++) {
      const source = prefixSource(format, at, mounts);
      if (source === undefined) break;
      const above = rows.get(`${source}/${row.locale}`);
      if (!above || above.own === null) {
        const slash = source.indexOf("/");
        const type = source.slice(0, slash);
        const id = source.slice(slash + 1);
        return `${type} "${await labelOf(type, id, defaultLocale)}"`;
      }
      at = above;
    }
    return "a page above it";
  }

  async function refuseLostPaths(rows: readonly DocRow[], current: readonly DocRow[], mounts: Mounts, moving: ReadonlySet<string>, saved: { key: string; locale: string; field: string } | undefined, field: string): Promise<void> {
    const before = new Map(current.map((r) => [r.id, r]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lost = rows.filter((r) => {
      if (!moving.has(docKey(r.type, r.docId)) || !r.live || r.own === null || r.tail !== null) return false;
      const own = saved !== undefined && docKey(r.type, r.docId) === saved.key && r.locale === saved.locale;
      return own || (before.get(r.id)?.tail ?? null) !== null;
    });
    if (lost.length === 0) return;
    const self = saved === undefined ? undefined : lost.find((r) => docKey(r.type, r.docId) === saved.key);
    if (self && saved) {
      const where = self.locale === "" ? "" : ` in "${self.locale}"`;
      throw fieldError(saved.field, `publishing${where} needs a slug${where} on ${await ancestorWithoutSlug(byId, self, mounts)} above it; a path takes its segments only from slugs of its own locale`);
    }
    const named = await Promise.all(lost.map(async (r) => `${r.type} "${await labelOf(r.type, r.docId, r.locale)}" (${r.locale === "" ? "no locale" : r.locale})`));
    throw fieldError(field, `${[...new Set(named)].join(", ")} ${lost.length === 1 ? "is" : "are"} published below and would lose ${lost.length === 1 ? "its" : "their"} path; give the page a slug in that locale or withdraw them first`);
  }

  function cascadeCost(change: Diff, rows: readonly DocRow[], saved: { key: string } | undefined): number {
    const counted = new Set(change.changed.map((c) => (c.after ?? c.before)!.id));
    if (saved !== undefined) for (const row of rows) if (docKey(row.type, row.docId) === saved.key) counted.add(row.id);
    return counted.size;
  }

  async function settleMoving(current: DocRow[], bases: Base[], mounts: Mounts, moving: Set<string>, field: (key: string) => string, cascade: { field: string; publishing: boolean }, runId: string, saved?: { key: string; locale: string; field: string }): Promise<Move[]> {
    const { rows, conflicts } = derive(format, bases, current, mounts);
    const pathConflicts: PathConflict[] = [];
    const fieldErrors: Array<{ field: string; message: string }> = [];
    for (const conflict of conflicts) {
      for (const loser of conflict.losers) {
        const key = docKey(loser.type, loser.id);
        if (!moving.has(key)) continue;
        const where = `${conflict.path} (${conflict.locale === "" ? "no locale" : conflict.locale})`;
        if (conflict.winner === null) {
          fieldErrors.push({ field: field(key), message: conflict.message ?? `${where} cannot be used` });
          continue;
        }
        const label = await labelOf(conflict.winner.type, conflict.winner.id, conflict.locale);
        pathConflicts.push({ path: conflict.path, locale: conflict.locale, type: conflict.winner.type, id: conflict.winner.id, label, moving: { type: loser.type, id: loser.id } });
        fieldErrors.push({ field: field(key), message: `${where} is taken by ${conflict.winner.type} "${label}"` });
      }
    }
    const unique = [...new Map(fieldErrors.map((e) => [`${e.field}\u0000${e.message}`, e])).values()];
    fieldErrors.splice(0, fieldErrors.length, ...unique);
    const text = [...new Set(fieldErrors.map((e) => e.message))].join("; ");
    if (pathConflicts.length > 0) throw new Abort(failure("CONFLICT", text, { details: { fields: fieldErrors, conflicts: pathConflicts } }));
    if (fieldErrors.length > 0) throw new Abort(failure("VALIDATION", text, { details: { fields: fieldErrors } }));
    await refuseLostPaths(rows, current, mounts, moving, saved, saved === undefined ? cascade.field : field(saved.key));
    const change = diff(current, current.flatMap((r) => claimOf(r) ?? []), rows);
    const cost = cascadeCost(change, rows, saved);
    if (cost > config.maxCascade) {
      const stall = `this change moves ${cost} paths (documents × locales), more than the limit of ${config.maxCascade} (config key maxCascade, preset option paths.maxCascade); a larger change blocks every request while it runs`;
      throw fieldError(cascade.field, stall);
    }
    return apply(change, runId, true);
  }

  async function hasTranslation(type: string, id: string, locale: string): Promise<boolean> {
    if (locale === defaultLocale) return true;
    const fields = model.types[type]?.fields ?? {};
    const localized = Object.keys(fields).filter((name) => {
      const field = fields[name];
      return typeof field === "object" && field.localized === true;
    });
    const doc = need(await content.get(type, id, localeOption(locale)), "content@1");
    return localized.some((name) => {
      const value = doc?.[name];
      return value !== null && value !== undefined && value !== "";
    });
  }

  async function refuseLiveWithoutSlug(type: string, id: string, fresh: readonly Base[], written: string, route: Route): Promise<void> {
    const base = fresh.find((b) => b.locale === written);
    if (!base || !base.live || base.own !== null) return;
    if (!(await hasTranslation(type, id, base.locale))) return;
    const where = base.locale === "" ? "" : ` in "${base.locale}"`;
    throw fieldError(route.slugField, `publishing${where} needs a slug of its own${base.locale === "" ? "" : " in that locale"}`);
  }

  async function index(type: string, id: string, runId: string, written: string): Promise<{ moves: Move[] }> {
    const route = routeOf(type);
    const fresh = await readBases(type, id);
    const current = await all<DocRow>(DOCS, {});
    const mounts = await readMounts();
    const key = docKey(type, id);
    const rowOf = (t: string, docId: string, locale = defaultLocale): DocRow | undefined => current.find((r) => r.type === t && r.docId === docId && r.locale === locale);
    const before = rowOf(type, id);

    if (!fresh) {
      const children = [...new Set(current.filter((r) => r.type === type && r.parent === id).map((r) => r.docId))];
      const mountedTypes = type === config.mountTarget ? Object.entries(mounts).filter(([, page]) => page === id).map(([t]) => t) : [];
      if (children.length > 0 || mountedTypes.length > 0) {
        const named = [...children.map((c) => `${type}/${c}`), ...mountedTypes.map((t) => `every ${t} (mounted here)`)];
        throw new Abort(failure("CONFLICT", `${type}/${id} still has subpages or mounted collections: ${named.join(", ")}`, { details: { children: children.map((c) => ({ type, id: c })), mounted: mountedTypes } }));
      }
    }

    const parent = fresh?.[0]?.parent ?? null;
    if (fresh && route.parentField !== null && parent !== null) {
      const field = route.parentField;
      if (parent === id) throw fieldError(field, `${type}/${id} cannot be its own parent`);
      const parentRow = rowOf(type, parent);
      if (!parentRow) throw fieldError(field, `the parent ${type}/${parent} does not exist or has no path`);
      if (parentRow.parent === null && parentRow.tail === "") throw fieldError(field, "the home page cannot have subpages");
      const ownDefault = fresh.find((b) => b.locale === defaultLocale)?.own ?? null;
      if (ownDefault !== null && ownDefault === route.home) throw fieldError(field, "the home page cannot have a parent");
      let depth = 1;
      for (let at: string | null = parent; at !== null; at = rowOf(type, at)?.parent ?? null) {
        if (at === id) throw fieldError(field, `${type}/${parent} lies below ${type}/${id}; that parent would make a cycle`);
        if (++depth > config.maxDepth) throw fieldError(field, `the parent chain would be deeper than ${config.maxDepth} (maxDepth)`);
      }
    }

    if (fresh) await refuseLiveWithoutSlug(type, id, fresh, written, route);

    const bases = [...baseOfRows(current.filter((r) => docKey(r.type, r.docId) !== key)), ...(fresh ?? [])];
    const moving = fresh ? descendants(bases, mounts, [key]) : new Set<string>();
    const slugChanged = fresh !== null && fresh.some((b) => (current.find((r) => r.id === rowId(type, id, b.locale))?.own ?? null) !== b.own);
    const parentChanged = fresh !== null && before !== undefined && before.parent !== parent;
    const liveField = Object.keys(route.liveWhen)[0];
    const liveChanged = fresh !== null && fresh.some((b) => current.find((r) => r.id === rowId(type, id, b.locale))?.live !== b.live);
    const structural = parentChanged && route.parentField !== null ? route.parentField : route.slugField;
    const publishing = !slugChanged && !parentChanged && liveChanged && liveField !== undefined;
    const cascade = { field: publishing ? liveField : structural, publishing };
    const aboveField = route.parentField !== null && parent !== null ? route.parentField : route.slugField;
    const saved = fresh ? { key, locale: written, field: aboveField } : undefined;
    return { moves: await settleMoving(current, bases, mounts, moving, () => structural, cascade, runId, saved) };
  }

  async function indexMounts(runId: string): Promise<{ moves: Move[] }> {
    const settings = config.mounts;
    if (!settings) throw new Error("site/default: site.indexMounts needs \"mounts\" in the site/default config");
    const raw = await storedMounts();
    const current = await all<DocRow>(DOCS, {});
    const problems: string[] = [];
    for (const [type, value] of Object.entries(raw)) {
      if (config.routes[type]?.mount !== true) problems.push(`"${type}" is not a mountable collection`);
      else if (value !== null && typeof value !== "string") problems.push(`${type}: expected a page id or null`);
    }
    const next = contentMounts(raw);
    const seen = new Map<string, string>();
    for (const [type, page] of Object.entries(next)) {
      if (page === null) continue;
      const row = current.find((r) => r.type === config.mountTarget && r.docId === page && r.locale === defaultLocale);
      if (!row) problems.push(`${type}: ${config.mountTarget}/${page} does not exist`);
      else if (row.parent === null && row.tail === "") problems.push(`${type}: the home page cannot hold a mounted collection`);
      const other = seen.get(page);
      if (other !== undefined) problems.push(`${config.mountTarget}/${page} is assigned to both ${other} and ${type}`);
      seen.set(page, type);
    }
    if (problems.length > 0) throw new Abort(failure("VALIDATION", `mounts: ${problems.join("; ")}`, { details: { fields: problems.map((message) => ({ field: settings.field, message })) } }));
    const previous = await readMounts();
    const changedTypes = Object.keys(next).filter((t) => next[t] !== previous[t]);
    if (changedTypes.length === 0) return { moves: [] };
    const bases = baseOfRows(current);
    const moving = new Set(bases.filter((b) => changedTypes.includes(b.type)).map((b) => docKey(b.type, b.docId)));
    const moves = await settleMoving(current, bases, next, moving, () => settings.field, { field: settings.field, publishing: false }, runId);
    await writeMounts(next);
    return { moves };
  }

  async function handle(row: RunRow): Promise<boolean> {
    if (inFlight.has(row.id)) return false;
    inFlight.add(row.id);
    try {
      await patchMemory(row.touched);
      if (events && row.moves.length > 0) for (const part of chunks(row.moves)) await events.emit(PATHS_MOVED, { moves: part });
      need(await db.updateOne<RunRow>(RUNS, row.id, { announced: true }), "persistence@1");
      return true;
    } catch (e) {
      logger.error("site/default: announcing path changes failed; site.resumePaths retries", { run: row.runId, seq: row.seq, error: e instanceof Abort ? e.error.message : e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      inFlight.delete(row.id);
    }
  }

  async function announceDue(runId: string | null): Promise<number> {
    let announced = 0;
    if (runId !== null) {
      const own = need(await db.findOne<RunRow>(RUNS, { id: runId }), "persistence@1");
      if (own && !own.announced && (await handle(own))) announced++;
    }
    const cutoff = now() - ANNOUNCE_GRACE_MS;
    let after = -1;
    for (;;) {
      const pending = need(await db.findMany<RunRow>(RUNS, { announced: false, seq: { gt: after } }, { sort: { seq: "asc" }, limit: 100 }), "persistence@1").items;
      for (const row of pending) {
        after = row.seq;
        const due = row.runId === null || row.at < bootedAt || row.at <= cutoff;
        if ((runId === null || row.runId !== runId) && due && (await handle(row))) announced++;
      }
      if (pending.length < 100 || runId !== null) return announced;
    }
  }


  async function write(plan: RebuildPlan, runId: string | null): Promise<RebuildReport> {
    const { rows, conflicts } = derive(format, plan.bases, plan.docs, plan.mounts);
    await apply(diff(plan.docs, plan.claims, rows), runId, plan.previous);
    await writeMounts(plan.mounts);
    const hash = routesHash(config, model);
    const meta = need(await db.findOne<MetaRow>(META, { id: "routes" }), "persistence@1");
    if (meta) need(await db.updateOne<MetaRow>(META, "routes", { hash }), "persistence@1");
    else need(await db.createOne<MetaRow>(META, { id: "routes", hash, value: null, ref: null }), "persistence@1");
    return { indexed: new Set(rows.map((r) => docKey(r.type, r.docId))).size, conflicts };
  }

  async function plan(): Promise<RebuildPlan> {
    const baseSeq = await readSeq();
    const docs = await all<DocRow>(DOCS, {});
    const claims = await all<ClaimRow>(PATHS, {});
    const previous = need(await db.findOne<MetaRow>(META, { id: "routes" }), "persistence@1") !== null;
    const bases = await readAllBases();
    const mounts = contentMounts(await storedMounts());
    return { baseSeq, previous, bases, docs, claims, mounts };
  }

  async function replan(stale: RebuildPlan): Promise<RebuildPlan> {
    const runs = need(await db.findMany<RunRow>(RUNS, { seq: { gt: stale.baseSeq } }), "persistence@1").items;
    const keys = new Set(runs.flatMap((r) => r.touched));
    if (keys.size === 0) return { ...stale, baseSeq: await readSeq() };
    const inKeys = (type: string, docId: string) => keys.has(docKey(type, docId));
    const bases = stale.bases.filter((b) => !inKeys(b.type, b.docId));
    for (const key of keys) {
      const at = key.indexOf("/");
      const type = key.slice(0, at);
      if (!config.routes[type]) continue;
      bases.push(...((await readBases(type, key.slice(at + 1))) ?? []));
    }
    const docs = [...stale.docs.filter((r) => !inKeys(r.type, r.docId)), ...(await byIds<DocRow>(DOCS, [...keys].flatMap((k) => locales.map((l) => `${k}/${l}`))))];
    const docIds = [...new Set([...keys].map((k) => k.slice(k.indexOf("/") + 1)))];
    const fresh: ClaimRow[] = [];
    for (const part of chunks(docIds)) fresh.push(...need(await db.findMany<ClaimRow>(PATHS, { docId: { in: part } }), "persistence@1").items);
    const claims = [...stale.claims.filter((c) => !inKeys(c.type, c.docId)), ...fresh.filter((c) => inKeys(c.type, c.docId))];
    return { baseSeq: await readSeq(), previous: stale.previous, bases, docs, claims, mounts: contentMounts(await storedMounts()) };
  }

  async function drifted(): Promise<boolean> {
    const stored = new Map<string, number>();
    for (const row of await all<DocRow>(DOCS, {})) stored.set(docKey(row.type, row.docId), row.updatedAt);
    let seen = 0;
    for (const type of Object.keys(config.routes)) {
      for (let offset = 0; ; offset += PAGE) {
        const page = need(await content.list(type, {}, { sort: { id: "asc" }, limit: PAGE, offset }), "content@1");
        for (const doc of page.items) {
          if (stored.get(docKey(type, doc.id)) !== doc.updatedAt) return true;
          seen++;
        }
        if (page.items.length < PAGE) break;
      }
    }
    if (seen !== stored.size) return true;
    const mounts = contentMounts(await storedMounts());
    const kept = await readMounts();
    return Object.keys(mounts).some((t) => mounts[t] !== kept[t]);
  }

  async function start(): Promise<void> {
    for (const [name, schema] of [
      [DOCS, DOC_SCHEMA],
      [PATHS, CLAIM_SCHEMA],
      [RUNS, RUN_SCHEMA],
      [META, META_SCHEMA],
    ] as const) {
      need(await db.ensureCollection(name, schema), "persistence@1");
    }
    const meta = need(await db.findOne<MetaRow>(META, { id: "routes" }), "persistence@1");
    if (meta?.hash !== routesHash(config, model) || (await drifted())) {
      const report = await write(await plan(), null);
      if (report.conflicts.length > 0) logger.error("site/default: paths rebuilt with conflicts; each losing document keeps no path until its slug changes", { conflicts: report.conflicts });
      else logger.info("site/default: paths rebuilt", { indexed: report.indexed });
    }
    table.load(await all<DocRow>(DOCS, {}));
    table.mounts = await readMounts();
  }

  const booted = await guarded(start);
  if (!booted.ok) throw new Error(`site/default: the path index could not be loaded: ${booted.error.message}`);

  return {
    config,
    table,
    format,
    route: (type) => config.routes[type],

    pathsOf(type, id, mode) {
      const out: Record<string, string | null> = {};
      for (const locale of locales) {
        const row = table.row(type, id, locale);
        if (mode === "reachable") out[locale] = reachablePath(format, row);
        else out[locale] = row && row.tail !== null && row.valid ? pathOfTail(format, row.tail, locale) : null;
      }
      return out;
    },

    index: (type, id, runId, locale) => guarded(() => index(type, id, runId, locale !== undefined && locales.includes(locale) ? locale : defaultLocale)),

    async announce(runId) {
      try {
        await announceDue(runId);
      } catch (e) {
        logger.error("site/default: announcing path changes failed; site.resumePaths retries", { error: e instanceof Abort ? e.error.message : e instanceof Error ? e.message : String(e) });
      }
    },

    resume: () =>
      guarded(async () => {
        const announced = await announceDue(null);
        const pruned = need(await db.deleteMany(RUNS, { announced: true, at: { lt: now() - RUN_RETENTION_MS } }), "persistence@1");
        return { announced, pruned };
      }),

    planRebuild: () => guarded(plan),

    applyRebuild: (stale, runId) =>
      guarded(async () => {
        const current = (await readSeq()) === stale.baseSeq ? stale : await replan(stale);
        return write(current, runId);
      }),

    preview: (type, input) =>
      guarded(async () => {
        const route = routeOf(type);
        const locale = input.locale ?? defaultLocale;
        const known = input.id === undefined ? undefined : table.row(type, input.id, locale);
        const parent = input.parent !== undefined ? input.parent : (known?.parent ?? null);
        const sourceKey = prefixSource(format, { type, parent }, table.mounts);
        const source = sourceKey === undefined ? undefined : table.row(sourceKey.slice(0, sourceKey.indexOf("/")), sourceKey.slice(sourceKey.indexOf("/") + 1), locale);
        const prefix = sourceKey === undefined ? undefined : (source?.tail ?? null);
        const tail = prefix === undefined ? tailOf(input.slug, route) : prefix === null ? null : prefix === "" ? input.slug : `${prefix}/${input.slug}`;
        if (tail === null) return { path: "", reachable: false, reason: "a page above has no slug in this locale", conflict: null, shadows: [], exposesParentSlug: null };
        const path = pathOfTail(format, tail, locale);
        const bad = violation(format, tail, locale);
        const claim = table.claim(locale, tail);
        const occupant = claim.strong && claim.strong.docId !== input.id ? claim.strong : undefined;
        const conflict = occupant ? { path, locale, type: occupant.type, id: occupant.docId, label: await labelOf(occupant.type, occupant.docId, locale) } : null;
        const shadows: PathPreview["shadows"] = [];
        for (const weak of claim.weak) {
          if (weak.docId === input.id || reachablePath(format, weak) === null) continue;
          shadows.push({ type: weak.type, id: weak.docId, label: await labelOf(weak.type, weak.docId, locale), path });
        }
        let exposesParentSlug: PathPreview["exposesParentSlug"] = null;
        for (let at = source, guard = 0; at && guard <= config.maxDepth; guard++) {
          if (!at.live) {
            exposesParentSlug = { type: at.type, id: at.docId, label: await labelOf(at.type, at.docId, locale) };
            break;
          }
          const next = prefixSource(format, at, table.mounts);
          at = next === undefined ? undefined : table.row(next.slice(0, next.indexOf("/")), next.slice(next.indexOf("/") + 1), locale);
        }
        const reason = bad ? bad.message : conflict ? `taken by ${conflict.type} "${conflict.label}"` : null;
        return { path, reachable: reason === null && (known?.live ?? false), reason, conflict, shadows, exposesParentSlug };
      }),

    indexMounts: (runId) => guarded(() => indexMounts(runId)),

    tree: (type) =>
      guarded(async () => {
        const route = routeOf(type);
        const labels = new Map<string, string>();
        for (let offset = 0; ; offset += PAGE) {
          const page = need(await content.list(type, {}, { sort: { id: "asc" }, limit: PAGE, offset }), "content@1");
          for (const doc of page.items) labels.set(doc.id, label(doc, route, doc.id));
          if (page.items.length < PAGE) break;
        }
        return [...labels].map(([id, name]) => {
          const paths: Record<string, string | null> = {};
          const live: Record<string, boolean> = {};
          for (const l of locales) {
            const row = table.row(type, id, l);
            paths[l] = row && row.tail !== null && row.valid ? pathOfTail(format, row.tail, l) : null;
            live[l] = row?.live ?? false;
          }
          return { id, parent: table.row(type, id, defaultLocale)?.parent ?? null, label: name, paths, live };
        });
      }),
  };
}
