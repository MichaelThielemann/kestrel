import { customFailure } from "../errors.ts";
import type { KestrelError } from "../errors.ts";

/** A migration's `up` produced data the model or schema rejects; the caller shows the message verbatim. */
export const migrationFailed = (message: string, details: { migration: string; document: string; locale?: string; problems?: unknown }): KestrelError<"MIGRATION_FAILED"> => customFailure("MIGRATION_FAILED", 500, message, { details });
