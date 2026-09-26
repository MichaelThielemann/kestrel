import { randomUUID } from "node:crypto";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { satisfiesFilter } from "@michaelthielemann/kestrel-contracts/content-locale";
import { err, failure, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Filter, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { defaultLocaleKey, localeKeys, PATHS_MOVED, routesHash, tailOf, type Move, type Route, type RoutesConfig } from "./routes.ts";
import {
  baseRow,
  claimId,
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
  settle,
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
}

export interface RebuildReport {
  indexed: number;
  conflicts: RebuildConflict[];
}

export interface PathPreview {
  path: string;
  reachable: boolean;
  reason: string | null;
  conflict: Omit<PathConflict, "moving"> | null;
  shadows: Array<{ type: string; id: string; label: string; path: string }>;
  exposesParentSlug: null;
}

export interface SitePaths {
  readonly config: RoutesConfig;
  readonly table: PathTable;
  readonly format: Formatter;
  route(type: string): Route | undefined;
  /** Locale key → path of `type/id`, reachable paths only or every valid path (drafts included). */
  pathsOf(type: string, id: string, mode: "reachable" | "valid"): Record<string, string | null>;
  /** Recomputes `type/id` and every document whose path depends on it, inside the caller's atomic group. */
  index(type: string, id: string, runId: string): Promise<Result<{ moves: Move[] }, PathsError>>;
  /** Patches memory from committed rows and raises the run's moves; never fails. */
  announce(runId: string | null): Promise<void>;
  resume(): Promise<Result<{ announced: number; pruned: number }, PathsError>>;
  planRebuild(): Promise<Result<RebuildPlan, PathsError>>;
  applyRebuild(plan: RebuildPlan, runId: string | null): Promise<Result<RebuildReport, PathsError>>;
  preview(type: string, input: { id?: string; locale?: string; slug: string }): Promise<Result<PathPreview, PathsError>>;
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
    else need(await db.createOne<MetaRow>(META, { id: "seq", hash: null, value }), "persistence@1");
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
      merged.set(key, { ...move, from: before ? before.from : move.from, seq: existing.seq });
    }
    const combined = [...merged.values()].filter((m) => m.from !== m.to);
    need(await db.updateOne<RunRow>(RUNS, id, { touched: [...new Set([...existing.touched, ...touched])], moves: combined, announced: false }), "persistence@1");
  }

  async function readBases(type: string, id: string): Promise<Base[] | null> {
    const route = routeOf(type);
    const own = new Map<string, string | null>();
    let stamp: { createdAt: number; updatedAt: number } | null = null;
    for (const locale of locales) {
      const doc = need(await content.get(type, id, localeOption(locale)), "content@1");
      if (!doc) return null;
      stamp = { createdAt: doc.createdAt, updatedAt: doc.updatedAt };
      own.set(locale, slugValue(doc[route.slugField]));
    }
    if (!stamp) return null;
    const fallback = own.get(defaultLocale) ?? null;
    const bases: Base[] = [];
    for (const locale of locales) {
      const live = need(await satisfiesFilter(content, type, id, locale === "" ? undefined : locale, route.liveWhen), "content@1");
      const ownSlug = own.get(locale) ?? null;
      bases.push({ type, docId: id, locale, own: ownSlug, slug: ownSlug ?? fallback, live, ...stamp });
    }
    return bases;
  }

  async function readAllBases(): Promise<Base[]> {
    const bases: Base[] = [];
    for (const [type, route] of Object.entries(config.routes)) {
      const own = new Map<string, Map<string, string | null>>();
      const stamps = new Map<string, { createdAt: number; updatedAt: number }>();
      const live = new Map<string, Set<string>>();
      for (const locale of locales) {
        const slugs = new Map<string, string | null>();
        for (let offset = 0; ; offset += PAGE) {
          const page = need(await content.list(type, {}, { ...localeOption(locale), sort: { id: "asc" }, limit: PAGE, offset }), "content@1");
          for (const doc of page.items) {
            slugs.set(doc.id, slugValue(doc[route.slugField]));
            stamps.set(doc.id, { createdAt: doc.createdAt, updatedAt: doc.updatedAt });
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
        const fallback = own.get(defaultLocale)?.get(id) ?? null;
        for (const locale of locales) {
          const ownSlug = own.get(locale)?.get(id) ?? null;
          bases.push({ type, docId: id, locale, own: ownSlug, slug: ownSlug ?? fallback, live: live.get(locale)?.has(id) ?? false, ...stamp });
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
  }

  async function index(type: string, id: string, runId: string): Promise<{ moves: Move[] }> {
    const route = routeOf(type);
    const bases = await readBases(type, id);
    const previous = new Map((need(await db.findMany<DocRow>(DOCS, { type, docId: id }, { limit: locales.length }), "persistence@1").items).map((r) => [r.locale, r]));
    const next = new Map<string, DocRow>();
    for (const base of bases ?? []) next.set(base.locale, baseRow(base, route));

    const fieldErrors = new Map<string, string>();
    for (const row of next.values()) {
      if (row.tail === null) continue;
      const bad = violation(format, row.tail, row.locale);
      if (bad) fieldErrors.set(bad.message, `${route.slugField}: ${bad.message}`);
    }
    if (fieldErrors.size > 0) {
      const messages = [...fieldErrors.keys()];
      throw new Abort(failure("VALIDATION", `${type}/${id}: ${messages.join("; ")}`, { details: { fields: messages.map((message) => ({ field: route.slugField, message })) } }));
    }

    const docRowOf = async (row: ClaimRow): Promise<DocRow | null> => need(await db.findOne<DocRow>(DOCS, { id: rowId(row.type, row.docId, row.locale) }), "persistence@1");
    const conflicts: PathConflict[] = [];
    const strongAt = new Map<string, ClaimRow | null>();
    for (const row of next.values()) {
      if (row.tail === null) continue;
      const strong = need(await db.findOne<ClaimRow>(PATHS, { id: claimId(row.locale, row.tail, "s", "") }), "persistence@1");
      strongAt.set(row.locale, strong);
      const taken: ClaimRow[] = [];
      if (row.strong && strong && strong.docId !== id) taken.push(strong);
      if (!row.strong) {
        const weak = need(await db.findMany<ClaimRow>(PATHS, { locale: row.locale, tail: row.tail, strength: "w" }), "persistence@1").items;
        taken.push(...weak.filter((w) => w.docId !== id));
      }
      for (const other of taken) {
        conflicts.push({ path: pathOfTail(format, row.tail, row.locale), locale: row.locale, type: other.type, id: other.docId, label: await labelOf(other.type, other.docId, row.locale), moving: { type, id } });
      }
    }
    if (conflicts.length > 0) {
      const text = conflicts.map((c) => `${c.path} (${c.locale === "" ? "no locale" : c.locale}) is taken by ${c.type} "${c.label}"`).join("; ");
      throw new Abort(failure("CONFLICT", `${type}/${id}: ${text}`, { details: { fields: conflicts.map((c) => ({ field: route.slugField, message: `${c.path} (${c.locale}) is taken by ${c.type} "${c.label}"` })), conflicts } }));
    }

    for (const row of next.values()) {
      if (row.tail === null || row.strong) continue;
      const strong = strongAt.get(row.locale);
      const holder = strong && strong.docId !== id ? await docRowOf(strong) : null;
      row.valid = !(holder?.live ?? false);
    }

    const changed = new Map<string, { before: DocRow | null; after: DocRow | null }>();
    for (const locale of locales) {
      const before = previous.get(locale) ?? null;
      const after = next.get(locale) ?? null;
      if (before && after && sameRow(before, after)) continue;
      if (before || after) changed.set(rowId(type, id, locale), { before, after });
    }

    const affectedTails: Array<{ locale: string; tail: string; strongLive: boolean }> = [];
    for (const locale of locales) {
      const before = previous.get(locale);
      const after = next.get(locale);
      const beforeStrong = before && before.tail !== null && before.strong ? before : undefined;
      const afterStrong = after && after.tail !== null && after.strong ? after : undefined;
      if (beforeStrong && (!afterStrong || afterStrong.tail !== beforeStrong.tail)) affectedTails.push({ locale, tail: beforeStrong.tail ?? "", strongLive: false });
      if (afterStrong && (!beforeStrong || beforeStrong.tail !== afterStrong.tail || beforeStrong.live !== afterStrong.live)) affectedTails.push({ locale, tail: afterStrong.tail ?? "", strongLive: afterStrong.live });
    }
    for (const { locale, tail, strongLive } of affectedTails) {
      const weak = need(await db.findMany<ClaimRow>(PATHS, { locale, tail, strength: "w" }), "persistence@1").items;
      for (const claim of weak) {
        if (claim.docId === id) continue;
        const holder = await docRowOf(claim);
        if (!holder || holder.valid === !strongLive) continue;
        changed.set(holder.id, { before: holder, after: { ...holder, valid: !strongLive } });
      }
    }

    const oldClaims = new Map<string, ClaimRow>();
    const newClaims = new Map<string, ClaimRow>();
    for (const row of previous.values()) {
      const claim = claimOf(row);
      if (claim && claim.docId === id) oldClaims.set(claim.id, claim);
    }
    for (const row of next.values()) {
      const claim = claimOf(row);
      if (claim) newClaims.set(claim.id, claim);
    }
    const removedClaims = [...oldClaims.values()].filter((c) => !newClaims.has(c.id) || !sameClaim(c, newClaims.get(c.id)!)).map((c) => c.id);
    const createdClaims = [...newClaims.values()].filter((c) => !oldClaims.has(c.id) || !sameClaim(c, oldClaims.get(c.id)!));
    await replaceRows(PATHS, removedClaims, createdClaims);
    await replaceRows(
      DOCS,
      [...changed.values()].flatMap((c) => (c.before ? [c.before.id] : [])),
      [...changed.values()].flatMap((c) => (c.after ? [c.after] : [])),
    );

    const seq = await takeSeq();
    const moves: Move[] = [];
    for (const { before, after } of changed.values()) {
      const from = reachablePath(format, before);
      const to = reachablePath(format, after);
      const ref = (after ?? before)!;
      if (from !== to) moves.push({ type: ref.type, id: ref.docId, locale: ref.locale, from, to, seq });
    }
    const touched = [...new Set([docKey(type, id), ...[...changed.values()].map(({ before, after }) => docKey((after ?? before)!.type, (after ?? before)!.docId))])];
    await writeRun(runId, touched, moves, seq);
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
    const pending = need(await db.findMany<RunRow>(RUNS, { announced: false }, { sort: { seq: "asc" }, limit: 100 }), "persistence@1").items;
    const cutoff = now() - ANNOUNCE_GRACE_MS;
    let announced = 0;
    for (const row of pending) {
      const due = (runId !== null && row.runId === runId) || row.runId === null || row.at < bootedAt || row.at <= cutoff;
      if (due && (await handle(row))) announced++;
    }
    return announced;
  }

  function derive(plan: RebuildPlan): { desired: DocRow[]; conflicts: RebuildConflict[] } {
    const { rows, conflicts } = settle(format, plan.bases, plan.docs);
    return { desired: rows, conflicts };
  }

  async function write(plan: RebuildPlan, runId: string | null): Promise<RebuildReport> {
    const { desired, conflicts } = derive(plan);
    const current = new Map(plan.docs.map((r) => [r.id, r]));
    const wanted = new Map(desired.map((r) => [r.id, r]));
    const removedDocs = [...current.keys()].filter((id) => !wanted.has(id) || !sameRow(current.get(id)!, wanted.get(id)!));
    const createdDocs = desired.filter((r) => !current.has(r.id) || !sameRow(current.get(r.id)!, r));
    const currentClaims = new Map(plan.claims.map((c) => [c.id, c]));
    const wantedClaims = new Map(desired.flatMap((r) => {
      const c = claimOf(r);
      return c ? [[c.id, c] as const] : [];
    }));
    const removedClaims = [...currentClaims.keys()].filter((id) => !wantedClaims.has(id) || !sameClaim(currentClaims.get(id)!, wantedClaims.get(id)!));
    const createdClaims = [...wantedClaims.values()].filter((c) => !currentClaims.has(c.id) || !sameClaim(currentClaims.get(c.id)!, c));
    await replaceRows(PATHS, removedClaims, createdClaims);
    await replaceRows(DOCS, removedDocs, createdDocs);
    const touched = new Set<string>();
    for (const id of [...removedDocs, ...createdDocs.map((r) => r.id)]) {
      const row = wanted.get(id) ?? current.get(id)!;
      touched.add(docKey(row.type, row.docId));
    }
    const seq = await takeSeq();
    const moves: Move[] = [];
    if (plan.previous) {
      for (const id of new Set([...current.keys(), ...wanted.keys()])) {
        const from = reachablePath(format, current.get(id));
        const to = reachablePath(format, wanted.get(id));
        const ref = (wanted.get(id) ?? current.get(id))!;
        if (from !== to) moves.push({ type: ref.type, id: ref.docId, locale: ref.locale, from, to, seq });
      }
    }
    await writeRun(runId, [...touched], moves, seq);
    const hash = routesHash(config, model);
    const meta = need(await db.findOne<MetaRow>(META, { id: "routes" }), "persistence@1");
    if (meta) need(await db.updateOne<MetaRow>(META, "routes", { hash }), "persistence@1");
    else need(await db.createOne<MetaRow>(META, { id: "routes", hash, value: null }), "persistence@1");
    return { indexed: new Set(desired.map((r) => docKey(r.type, r.docId))).size, conflicts };
  }

  async function plan(): Promise<RebuildPlan> {
    const baseSeq = await readSeq();
    const docs = await all<DocRow>(DOCS, {});
    const claims = await all<ClaimRow>(PATHS, {});
    const previous = need(await db.findOne<MetaRow>(META, { id: "routes" }), "persistence@1") !== null;
    const bases = await readAllBases();
    return { baseSeq, previous, bases, docs, claims };
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
    return { baseSeq: await readSeq(), previous: stale.previous, bases, docs, claims };
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
    return seen !== stored.size;
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

    index: (type, id, runId) => guarded(() => index(type, id, runId)),

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
        const tail = tailOf(input.slug, route);
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
        const live = input.id === undefined ? false : (table.row(type, input.id, locale)?.live ?? false);
        const reason = bad ? bad.message : conflict ? `taken by ${conflict.type} "${conflict.label}"` : live ? null : "not published in this locale";
        return { path, reachable: reason === null, reason, conflict, shadows, exposesParentSlug: null };
      }),
  };
}
