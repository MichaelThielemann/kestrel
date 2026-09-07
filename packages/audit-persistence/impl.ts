import type { Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";

export const COLLECTION = "audit_entries";

export interface AuditEntry {
  eventId: string | null;
  event: string;
  at: number;
  identityId: string | null;
  params: Record<string, string>;
}

export interface Audit {
  record(entry: AuditEntry): Promise<Result<void, PersistenceError>>;
}

export async function createAuditPersistence(db: Persistence): Promise<Audit> {
  const prepared = await db.ensureCollection(COLLECTION, { eventId: "string", event: "string", at: "number", identityId: "string", params: "json" });
  if (isErr(prepared)) throw new Error(`audit/persistence: ${prepared.error.message}`);
  return {
    async record(entry) {
      if (entry.eventId !== null) {
        const existing = await db.findOne(COLLECTION, { eventId: entry.eventId });
        if (isErr(existing)) return existing;
        if (existing.value !== null) return ok();
      }
      const created = await db.createOne(COLLECTION, { ...entry });
      if (isErr(created)) return created;
      return ok();
    },
  };
}

export function entryFromEventData(data: Record<string, unknown>): AuditEntry {
  const { eventId, event, at, identity, params } = data;
  if (typeof event !== "string" || typeof at !== "number") throw new Error("audit/persistence: payload is not event data (expected event and at)");
  const identityId = typeof identity === "object" && identity !== null && typeof (identity as { id?: unknown }).id === "string" ? (identity as { id: string }).id : null;
  return { eventId: typeof eventId === "string" ? eventId : null, event, at, identityId, params: typeof params === "object" && params !== null ? (params as Record<string, string>) : {} };
}
