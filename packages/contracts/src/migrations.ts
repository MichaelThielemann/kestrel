import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { ContentDocument } from "./content.ts";
import { customFailure, type KestrelError, type Result } from "./errors.ts";

export interface MigrationContext {
  document: ContentDocument;
  locale?: string;
}

export interface Migration {
  id: string;
  collection: string;
  up(ctx: MigrationContext): ContentDocument | Record<string, unknown> | null;
}

export interface LedgerEntry {
  id: string;
  appliedAt: number;
  documents: number;
  durationMs: number;
}

export interface PendingMigration {
  id: string;
  collection: string;
}

export type ApplyResult = { dry: true; changes: { id: string; documents: number }[] } | { dry?: false; applied: LedgerEntry[] };

export type MigrationsCode = "CONFLICT" | "TRANSIENT" | "MIGRATION_FAILED";
export type MigrationsError = KestrelError<MigrationsCode>;

/** A migration's `up` produced data the model or schema rejects; the caller shows the message verbatim. */
export const migrationFailed = (message: string, details: { migration: string; document: string; locale?: string; problems?: unknown }): KestrelError<"MIGRATION_FAILED"> => customFailure("MIGRATION_FAILED", 500, message, { details });

/** Construction never applies anything; running migrations at boot is the providing module's job. */
export interface Migrations {
  list(): Promise<Result<{ applied: LedgerEntry[]; pending: PendingMigration[] }, MigrationsError>>;
  /** The migrations still pending, in config order. Never fails for "pending". */
  check(): Promise<Result<PendingMigration[], MigrationsError>>;
  /** Applies every pending migration, in config order. */
  apply(options?: { dry?: boolean }): Promise<Result<ApplyResult, MigrationsError>>;
}

export const MIGRATIONS = defineContract<Migrations>()("migrations@1", ["list", "check", "apply"]);
