import { Buffer } from "node:buffer";
import { err, failure, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import type { NewRevision, PruneReport, PruneScope, Revision, RevisionListOptions, RevisionPage, Revisions, RevisionsError, RevisionSummary } from "@michaelthielemann/kestrel-contracts/revisions";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";

export const ENTRIES = "revisions_entries";
export const HEADS = "revisions_heads";

const CHUNK = 100;

export interface RevisionsConfig {
  keep: number;
  maxSnapshotBytes: number;
  pruneOnWrite: boolean;
  statusField: string;
  liveStatuses: string[];
  maxLimit: number;
}

interface EntryRow extends Document {
  collection: string;
  documentId: string;
  locale: string;
  parentId: string | null;
  createdAt: number;
  authorId: string | null;
  authorName: string | null;
  kind: string;
  label: string | null;
  status: string | null;
  live: boolean;
  bytes: number;
  skipped: boolean;
  snapshot: Record<string, unknown> | null;
}

interface HeadRow extends Document {
  collection: string;
  documentId: string;
  locale: string;
  revisionId: string;
  updatedAt: number;
}

export interface RevisionsDeps {
  db: Persistence;
  logger: Logger;
  now?: () => number;
}

function storageError(error: PersistenceError): RevisionsError {
  const options: { details?: Record<string, unknown>; cause?: unknown } = {};
  if (error.details !== undefined) options.details = error.details;
  if (error.cause !== undefined) options.cause = error.cause;
  return failure(error.code === "NOT_FOUND" ? "NOT_FOUND" : "TRANSIENT", error.message, options);
}

function headKey(collection: string, documentId: string, locale: string): string {
  return `${collection}\u0000${documentId}\u0000${locale}`;
}

function summaryOf(row: EntryRow): RevisionSummary {
  return {
    id: row.id,
    collection: row.collection,
    documentId: row.documentId,
    locale: row.locale,
    parentId: row.parentId,
    createdAt: row.createdAt,
    author: { id: row.authorId, name: row.authorName },
    kind: row.kind === "restore" ? "restore" : "save",
    label: row.label,
    status: row.status,
    live: row.live,
    bytes: row.bytes,
    skipped: row.skipped,
  };
}

function revisionOf(row: EntryRow): Revision {
  return { ...summaryOf(row), snapshot: row.snapshot };
}

/**
 * The retention decision for one group, newest first: an index below `keep`, a live or labelled
 * revision, the head, and every revision whose child count is not exactly one — none means a
 * branch tip, several a branch point.
 */
export function keptRevisions<T extends { id: string; parentId: string | null; live: boolean; label: string | null }>(newestFirst: readonly T[], keep: number, head: string | null): Set<string> {
  const children = new Map<string, number>();
  for (const row of newestFirst) {
    if (row.parentId !== null) children.set(row.parentId, (children.get(row.parentId) ?? 0) + 1);
  }
  return new Set(newestFirst.filter((row, index) => index < keep || row.live || row.label !== null || row.id === head || (children.get(row.id) ?? 0) !== 1).map((row) => row.id));
}

/** The nearest ancestor that survives pruning, so a removed revision never orphans its children. */
export function survivingParent(parentId: string | null, kept: ReadonlySet<string>, parents: ReadonlyMap<string, string | null>): string | null {
  let current = parentId;
  while (current !== null && !kept.has(current)) current = parents.get(current) ?? null;
  return current;
}

export async function createRevisionsDefault(config: RevisionsConfig, deps: RevisionsDeps): Promise<Revisions> {
  const { db, logger } = deps;
  const clock = deps.now ?? Date.now;

  const prepared = await db.ensureCollection(ENTRIES, {
    collection: "string",
    documentId: "string",
    locale: "string",
    parentId: "string",
    createdAt: "number",
    authorId: "string",
    authorName: "string",
    kind: "string",
    label: "string",
    status: "string",
    live: "boolean",
    bytes: "number",
    skipped: "boolean",
    snapshot: "json",
  });
  if (isErr(prepared)) throw new Error(`revisions/default: cannot prepare "${ENTRIES}": ${prepared.error.message}`);
  const preparedHeads = await db.ensureCollection(HEADS, { collection: "string", documentId: "string", locale: "string", revisionId: "string", updatedAt: "number" });
  if (isErr(preparedHeads)) throw new Error(`revisions/default: cannot prepare "${HEADS}": ${preparedHeads.error.message}`);

  // Strictly increasing timestamps, so several saves within one millisecond still list in order.
  const newest = await db.findMany<EntryRow>(ENTRIES, {}, { sort: { createdAt: "desc" }, limit: 1 });
  let last = isErr(newest) ? 0 : (newest.value.items[0]?.createdAt ?? 0);
  const now = (): number => {
    last = Math.max(clock(), last + 1);
    return last;
  };

  const groupRows = async (collection: string, documentId: string, locale: string): Promise<Result<EntryRow[], RevisionsError>> => {
    const page = await db.findMany<EntryRow>(ENTRIES, { collection, documentId, locale }, { sort: { createdAt: "desc" } });
    if (isErr(page)) return err(storageError(page.error));
    return ok(page.value.items);
  };

  const headOf = async (collection: string, documentId: string, locale: string): Promise<Result<string | null, RevisionsError>> => {
    const row = await db.findOne<HeadRow>(HEADS, { id: headKey(collection, documentId, locale) });
    if (isErr(row)) return err(storageError(row.error));
    return ok(row.value?.revisionId ?? null);
  };

  const setHead = async (collection: string, documentId: string, locale: string, revisionId: string): Promise<Result<void, RevisionsError>> => {
    const id = headKey(collection, documentId, locale);
    const updated = await db.updateOne<HeadRow>(HEADS, id, { revisionId, updatedAt: now() });
    if (!isErr(updated)) return ok();
    if (updated.error.code !== "NOT_FOUND") return err(storageError(updated.error));
    const created = await db.createOne<HeadRow>(HEADS, { id, collection, documentId, locale, revisionId, updatedAt: now() });
    if (isErr(created)) return err(storageError(created.error));
    return ok();
  };

  const deleteIds = async (ids: readonly string[]): Promise<Result<number, RevisionsError>> => {
    let removed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const gone = await db.deleteMany(ENTRIES, { id: { in: ids.slice(i, i + CHUNK) } });
      if (isErr(gone)) return err(storageError(gone.error));
      removed += gone.value;
    }
    return ok(removed);
  };

  const pruneGroup = async (collection: string, documentId: string, locale: string): Promise<Result<PruneReport, RevisionsError>> => {
    const rows = await groupRows(collection, documentId, locale);
    if (isErr(rows)) return rows;
    const head = await headOf(collection, documentId, locale);
    if (isErr(head)) return head;
    const kept = keptRevisions(rows.value, config.keep, head.value);
    if (kept.size === rows.value.length) return ok({ inspected: rows.value.length, removed: 0 });
    const parents = new Map(rows.value.map((row) => [row.id, row.parentId]));
    for (const row of rows.value) {
      if (!kept.has(row.id)) continue;
      const parentId = survivingParent(row.parentId, kept, parents);
      if (parentId === row.parentId) continue;
      const moved = await db.updateOne<EntryRow>(ENTRIES, row.id, { parentId });
      if (isErr(moved)) return err(storageError(moved.error));
    }
    const removed = await deleteIds(rows.value.filter((row) => !kept.has(row.id)).map((row) => row.id));
    if (isErr(removed)) return removed;
    return ok({ inspected: rows.value.length, removed: removed.value });
  };

  return {
    async record(entry: NewRevision): Promise<Result<RevisionSummary, RevisionsError>> {
      let parentId = entry.parentId ?? null;
      if (entry.parentId === undefined) {
        const head = await headOf(entry.collection, entry.documentId, entry.locale);
        if (isErr(head)) return head;
        parentId = head.value;
      }
      if (parentId !== null) {
        const parent = await db.findOne<EntryRow>(ENTRIES, { id: parentId });
        if (isErr(parent)) return err(storageError(parent.error));
        if (!parent.value) return err(failure("NOT_FOUND", `revisions/default: no revision "${parentId}"`));
      }
      const bytes = Buffer.byteLength(JSON.stringify(entry.fields));
      const skipped = bytes > config.maxSnapshotBytes;
      if (skipped) {
        logWarn(logger, "revisions/default: snapshot exceeds maxSnapshotBytes, recorded without content", { collection: entry.collection, documentId: entry.documentId, locale: entry.locale, bytes, maxSnapshotBytes: config.maxSnapshotBytes });
      }
      const created = await db.createOne<EntryRow>(ENTRIES, {
        collection: entry.collection,
        documentId: entry.documentId,
        locale: entry.locale,
        parentId,
        createdAt: now(),
        authorId: entry.author.id,
        authorName: entry.author.name,
        kind: entry.kind,
        label: entry.label ?? null,
        status: entry.status ?? null,
        live: entry.live ?? false,
        bytes,
        skipped,
        snapshot: skipped ? null : entry.fields,
      });
      if (isErr(created)) return err(storageError(created.error));
      const head = await setHead(entry.collection, entry.documentId, entry.locale, created.value.id);
      if (isErr(head)) return head;
      if (!config.pruneOnWrite) return ok(summaryOf(created.value));
      const pruned = await pruneGroup(entry.collection, entry.documentId, entry.locale);
      if (isErr(pruned)) return pruned;
      if (pruned.value.removed === 0) return ok(summaryOf(created.value));
      // Pruning may have removed the parent and re-parented this revision onto its grandparent.
      const fresh = await db.findOne<EntryRow>(ENTRIES, { id: created.value.id });
      if (isErr(fresh)) return err(storageError(fresh.error));
      return ok(summaryOf(fresh.value ?? created.value));
    },

    async list(collection: string, documentId: string, locale: string, options: RevisionListOptions = {}): Promise<Result<RevisionPage, RevisionsError>> {
      const find = { sort: { createdAt: "desc" as const }, ...(options.limit === undefined ? {} : { limit: Math.min(options.limit, config.maxLimit) }), ...(options.offset === undefined ? {} : { offset: options.offset }) };
      const page = await db.findMany<EntryRow>(ENTRIES, { collection, documentId, locale }, find);
      if (isErr(page)) return err(storageError(page.error));
      const head = await headOf(collection, documentId, locale);
      if (isErr(head)) return head;
      return ok({ items: page.value.items.map(summaryOf), total: page.value.total, head: head.value });
    },

    async read(collection: string, documentId: string, revisionId: string): Promise<Result<Revision | null, RevisionsError>> {
      const row = await db.findOne<EntryRow>(ENTRIES, { id: revisionId, collection, documentId });
      if (isErr(row)) return err(storageError(row.error));
      return ok(row.value ? revisionOf(row.value) : null);
    },

    async label(collection: string, documentId: string, revisionId: string, label: string | null): Promise<Result<RevisionSummary, RevisionsError>> {
      const row = await db.findOne<EntryRow>(ENTRIES, { id: revisionId, collection, documentId });
      if (isErr(row)) return err(storageError(row.error));
      if (!row.value) return err(failure("NOT_FOUND", `revisions/default: no revision "${revisionId}" of ${collection}/${documentId}`));
      const updated = await db.updateOne<EntryRow>(ENTRIES, revisionId, { label });
      if (isErr(updated)) return err(storageError(updated.error));
      return ok(summaryOf(updated.value));
    },

    head: headOf,

    async prune(scope: PruneScope = {}): Promise<Result<PruneReport, RevisionsError>> {
      const filter: Record<string, unknown> = {};
      if (scope.collection !== undefined) filter.collection = scope.collection;
      if (scope.documentId !== undefined) filter.documentId = scope.documentId;
      if (scope.locale !== undefined) filter.locale = scope.locale;
      const groups = await db.findMany<HeadRow>(HEADS, filter);
      if (isErr(groups)) return err(storageError(groups.error));
      const report: PruneReport = { inspected: 0, removed: 0 };
      for (const group of groups.value.items) {
        const pruned = await pruneGroup(group.collection, group.documentId, group.locale);
        if (isErr(pruned)) return pruned;
        report.inspected += pruned.value.inspected;
        report.removed += pruned.value.removed;
      }
      return ok(report);
    },

    async remove(collection: string, documentId: string, locale?: string): Promise<Result<number, RevisionsError>> {
      const filter = { collection, documentId, ...(locale === undefined ? {} : { locale }) };
      const removed = await db.deleteMany(ENTRIES, filter);
      if (isErr(removed)) return err(storageError(removed.error));
      const heads = await db.deleteMany(HEADS, filter);
      if (isErr(heads)) return err(storageError(heads.error));
      return ok(removed.value);
    },
  };
}

/** The status the consumer's model carries and whether it counts as live, both from the config. */
export function statusOf(config: RevisionsConfig, fields: Record<string, unknown>): { status: string | null; live: boolean } {
  const raw = fields[config.statusField];
  const status = typeof raw === "string" ? raw : null;
  return { status, live: status !== null && config.liveStatuses.includes(status) };
}

const IGNORED = new Set(["id", "createdAt", "updatedAt"]);

/** The saved document reduced to the fields a write accepts back: no id, no timestamps, no reading aids. */
export function snapshotFields(document: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (IGNORED.has(key) || key.startsWith("_")) continue;
    fields[key] = value;
  }
  return fields;
}

/** The saved document from `ctx.result`, which the content steps leave either bare or under `document`. */
export function documentOf(result: unknown): Record<string, unknown> | null {
  const value = boundaryCast<{ id?: unknown; document?: { id?: unknown } } | null | undefined>(result, "json");
  if (value && typeof value.document?.id === "string") return boundaryCast<Record<string, unknown>>(value.document, "json");
  if (value && typeof value.id === "string") return boundaryCast<Record<string, unknown>>(value, "json");
  return null;
}
