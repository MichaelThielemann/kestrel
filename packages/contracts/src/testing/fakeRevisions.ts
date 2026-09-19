import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { err, failure, ok, type Result } from "../errors.ts";
import type { NewRevision, PruneReport, PruneScope, Revision, RevisionListOptions, RevisionPage, Revisions, RevisionsError, RevisionSummary } from "../revisions.ts";

export interface FakeRevisionsOptions {
  /** How many newest revisions per (collection, document, locale) `prune` keeps. */
  keep?: number;
  now?: () => number;
}

type Stored = Revision;

const groupKey = (collection: string, documentId: string, locale: string): string => JSON.stringify([collection, documentId, locale]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function summaryOf(entry: Stored): RevisionSummary {
  const { snapshot: _snapshot, ...summary } = entry;
  void _snapshot;
  return summary;
}

/** In-memory `revisions@1` for tests of packages that only need a history to exist. */
export function createFakeRevisions(options: FakeRevisionsOptions = {}): Revisions {
  const keep = options.keep ?? 50;
  const clock = options.now ?? Date.now;
  const entries = new Map<string, Stored>();
  const heads = new Map<string, string>();
  let last = 0;
  const now = (): number => {
    last = Math.max(clock(), last + 1);
    return last;
  };

  const groupOf = (collection: string, documentId: string, locale: string): Stored[] =>
    [...entries.values()].filter((e) => e.collection === collection && e.documentId === documentId && e.locale === locale).sort((a, b) => b.createdAt - a.createdAt);

  const pruneGroup = (group: Stored[], headId: string | null): number => {
    const children = new Map<string, number>();
    for (const entry of group) {
      if (entry.parentId !== null) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
    }
    const kept = new Set(
      group.filter((entry, index) => index < keep || entry.live || entry.label !== null || entry.id === headId || (children.get(entry.id) ?? 0) !== 1).map((entry) => entry.id),
    );
    for (const entry of group) {
      if (!kept.has(entry.id)) continue;
      let parentId = entry.parentId;
      while (parentId !== null && !kept.has(parentId)) parentId = entries.get(parentId)?.parentId ?? null;
      entries.set(entry.id, { ...entry, parentId });
    }
    const removed = group.filter((entry) => !kept.has(entry.id));
    for (const entry of removed) entries.delete(entry.id);
    return removed.length;
  };

  return {
    async record(entry: NewRevision): Promise<Result<RevisionSummary, RevisionsError>> {
      const key = groupKey(entry.collection, entry.documentId, entry.locale);
      const headId = heads.get(key) ?? null;
      const parentId = entry.parentId === undefined ? headId : entry.parentId;
      const parent = parentId === null ? null : entries.get(parentId);
      if (parentId !== null && (!parent || groupKey(parent.collection, parent.documentId, parent.locale) !== key)) {
        return err(failure("NOT_FOUND", `revisions: no revision "${parentId}" of ${entry.collection}/${entry.documentId} (${entry.locale})`));
      }
      if (entry.kind === "save" && parentId === headId && parent && !parent.skipped) {
        const status = entry.status ?? null;
        if (status === parent.status && deepEqual(entry.fields, parent.snapshot)) {
          return ok(summaryOf(parent));
        }
      }
      const snapshot = { ...entry.fields };
      const stored: Stored = {
        id: randomUUID(),
        collection: entry.collection,
        documentId: entry.documentId,
        locale: entry.locale,
        parentId,
        createdAt: now(),
        author: entry.author,
        kind: entry.kind,
        label: entry.label ?? null,
        status: entry.status ?? null,
        live: entry.live ?? false,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
        skipped: false,
        snapshot,
      };
      entries.set(stored.id, stored);
      heads.set(key, stored.id);
      return ok(summaryOf(stored));
    },

    async list(collection: string, documentId: string, locale: string, listOptions: RevisionListOptions = {}): Promise<Result<RevisionPage, RevisionsError>> {
      const group = groupOf(collection, documentId, locale);
      const offset = listOptions.offset ?? 0;
      const page = group.slice(offset, listOptions.limit === undefined ? undefined : offset + listOptions.limit);
      return ok({ items: page.map(summaryOf), total: group.length, head: heads.get(groupKey(collection, documentId, locale)) ?? null });
    },

    async read(collection: string, documentId: string, revisionId: string): Promise<Result<Revision | null, RevisionsError>> {
      const entry = entries.get(revisionId);
      if (!entry || entry.collection !== collection || entry.documentId !== documentId) return ok(null);
      return ok({ ...entry });
    },

    async label(collection: string, documentId: string, revisionId: string, label: string | null): Promise<Result<RevisionSummary, RevisionsError>> {
      const entry = entries.get(revisionId);
      if (!entry || entry.collection !== collection || entry.documentId !== documentId) return err(failure("NOT_FOUND", `revisions: no revision "${revisionId}"`));
      const next: Stored = { ...entry, label };
      entries.set(revisionId, next);
      return ok(summaryOf(next));
    },

    async head(collection: string, documentId: string, locale: string): Promise<Result<string | null, RevisionsError>> {
      return ok(heads.get(groupKey(collection, documentId, locale)) ?? null);
    },

    async prune(scope: PruneScope = {}): Promise<Result<PruneReport, RevisionsError>> {
      const groups = new Map<string, Stored[]>();
      for (const entry of entries.values()) {
        if (scope.collection !== undefined && entry.collection !== scope.collection) continue;
        if (scope.documentId !== undefined && entry.documentId !== scope.documentId) continue;
        if (scope.locale !== undefined && entry.locale !== scope.locale) continue;
        const key = groupKey(entry.collection, entry.documentId, entry.locale);
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      }
      let inspected = 0;
      let removed = 0;
      for (const [key, group] of groups) {
        inspected += group.length;
        removed += pruneGroup([...group].sort((a, b) => b.createdAt - a.createdAt), heads.get(key) ?? null);
      }
      return ok({ inspected, removed });
    },

    async remove(collection: string, documentId: string, locale?: string): Promise<Result<number, RevisionsError>> {
      let removed = 0;
      for (const entry of [...entries.values()]) {
        if (entry.collection !== collection || entry.documentId !== documentId) continue;
        if (locale !== undefined && entry.locale !== locale) continue;
        entries.delete(entry.id);
        removed += 1;
      }
      for (const [key, head] of [...heads]) {
        if (!entries.has(head)) heads.delete(key);
      }
      return ok(removed);
    },
  };
}
