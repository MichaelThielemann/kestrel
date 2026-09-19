import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";
import type { Page } from "./query.ts";

export type { Page } from "./query.ts";

/** How far a snapshot still fits the content model, so a restore can warn instead of failing. */
export interface RestoreReport {
  revisionId: string;
  /** Fields of the snapshot the model no longer has; a restore leaves them out. */
  dropped: string[];
  /** Fields the model gained after the snapshot; a restore cannot revert them and leaves them as they are. */
  missing: string[];
}

declare global {
  namespace Kestrel {
    interface ContextExtensions {
      /** The revision the next `record` of this run branches from; set by a restore, absent for a normal save. */
      revisionParent?: string;
      /** What the restore of this run had to leave out; absent when nothing knows the current model. */
      restoreReport?: RestoreReport;
    }
  }
}

/** The identity at save time. `name` is a snapshot, so a later rename does not rewrite history. */
export interface RevisionAuthor {
  id: string | null;
  name: string | null;
}

/** `save` is an ordinary write, `restore` is a write whose content came from an earlier revision. */
export type RevisionKind = "save" | "restore";

export interface RevisionSummary {
  id: string;
  collection: string;
  documentId: string;
  locale: string;
  parentId: string | null;
  createdAt: number;
  author: RevisionAuthor;
  kind: RevisionKind;
  label: string | null;
  /** The value of the recorded status field at save time, `null` when the document has none. */
  status: string | null;
  /** The recorded state counted as live (published) at save time; such a revision is never pruned. */
  live: boolean;
  /** Size of the snapshot as stored JSON, also when it was too large to keep. */
  bytes: number;
  /** The snapshot exceeded the size limit and was not stored; the revision cannot be restored. */
  skipped: boolean;
}

export interface Revision extends RevisionSummary {
  /** The saved fields, `null` for a skipped revision. */
  snapshot: Record<string, unknown> | null;
}

export interface NewRevision {
  collection: string;
  documentId: string;
  locale: string;
  /** The document as it was saved, without `id`, timestamps and the `_`-prefixed reading aids. */
  fields: Record<string, unknown>;
  author: RevisionAuthor;
  kind: RevisionKind;
  status?: string | null;
  live?: boolean;
  /** Omitted: the current head. Naming an older revision forks the history there. */
  parentId?: string | null;
  label?: string | null;
}

export interface RevisionListOptions {
  limit?: number;
  offset?: number;
}

/** A page of revisions, newest first and without snapshots, plus the head the next save builds on. */
export interface RevisionPage extends Page<RevisionSummary> {
  head: string | null;
}

export interface PruneScope {
  collection?: string;
  documentId?: string;
  locale?: string;
}

export interface PruneReport {
  inspected: number;
  removed: number;
}

export type RevisionsError = KestrelError<"NOT_FOUND" | "TRANSIENT">;

/**
 * Append-only version history per (collection, document, locale). Branching follows from
 * `parentId` alone: a save's parent is the head, a save after a restore is the restored
 * revision, which forks the line there. There is no merge.
 */
export interface Revisions {
  /**
   * Appends a revision and makes it the head. `NOT_FOUND` when a named `parentId` is not a
   * revision of the same collection, document and locale, so an edge never leaves its history.
   *
   * A `save` whose parent is the current head and whose snapshot and status are both identical
   * (deep, key-order-independent) to that head's is not recorded; the call succeeds and returns
   * the head's summary unchanged. A skipped (oversized) snapshot never counts as identical. A
   * `restore`, and a `save` whose parent is not the head, are always recorded.
   */
  record(entry: NewRevision): Promise<Result<RevisionSummary, RevisionsError>>;
  list(collection: string, documentId: string, locale: string, options?: RevisionListOptions): Promise<Result<RevisionPage, RevisionsError>>;
  /** The revision including its snapshot; an id of another document or collection is `Ok(null)`, like an unknown one. */
  read(collection: string, documentId: string, revisionId: string): Promise<Result<Revision | null, RevisionsError>>;
  /** Sets or, with `null`, clears the label; an id of another document or collection is `NOT_FOUND`. */
  label(collection: string, documentId: string, revisionId: string, label: string | null): Promise<Result<RevisionSummary, RevisionsError>>;
  head(collection: string, documentId: string, locale: string): Promise<Result<string | null, RevisionsError>>;
  /** Applies the retention rules; a removed revision's children are re-parented, never orphaned. */
  prune(scope?: PruneScope): Promise<Result<PruneReport, RevisionsError>>;
  /** Drops a document's revisions, or only those of one locale. Returns how many were removed. */
  remove(collection: string, documentId: string, locale?: string): Promise<Result<number, RevisionsError>>;
}

export const REVISIONS = defineContract<Revisions>()("revisions@1", ["record", "list", "read", "label", "head", "prune", "remove"]);
