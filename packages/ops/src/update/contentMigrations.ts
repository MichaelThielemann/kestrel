import type { UpdateContext } from "./types.ts";
import { notImplemented } from "./pending.ts";

/** What {@link runContentMigrations} works on. */
export interface ContentMigrationInput {
  /** The database copy the content migrations change in place; it already holds the release's storage shape. */
  database: string;
  /** A local directory that stands in for the blob store during the local start. */
  blobsDir: string;
  /** Content migration ids the plan expects; the local start runs no others. */
  expected: readonly string[];
}

/** What a local start of the release applied. */
export interface ContentMigrationResult {
  /** False when nothing was pending and no local start ran. */
  ran: boolean;
  applied: string[];
  /** Milliseconds from the start of the local process until it reported ready. */
  bootMs: number | null;
}

/**
 * Applies the release's pending content migrations by starting the release on this machine on `input.database`
 * through `update.localBoot`, with an environment of exactly the `localBoot.env` values (placeholders `{database}`,
 * `{blobs}` and `{port}` filled in) and the host's `localBootEnv`, never a variable of this process's environment, and
 * stops it once ready. Nothing runs when nothing is pending. The local start gets its own build identity, so the
 * production start renders every output again. Refuses with exit 2 when content migrations are pending and
 * `update.localBoot` is not configured.
 */
export async function runContentMigrations(ctx: UpdateContext, input: ContentMigrationInput): Promise<ContentMigrationResult> {
  return notImplemented(`runContentMigrations(${input.database})`);
}
