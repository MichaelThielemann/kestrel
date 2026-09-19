import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";

export const COLLECTION = "audit_entries";

const CHUNK = 200;
const DAY_MS = 86400000;

export interface AuditEntry {
  eventId: string | null;
  event: string;
  at: number;
  identityId: string | null;
  params: Record<string, string>;
}

interface EntryRow extends Document {
  eventId: string | null;
  event: string;
  at: number;
  identityId: string | null;
  params: Record<string, string>;
}

export interface Audit {
  record(entry: AuditEntry): Promise<Result<void, PersistenceError>>;
  /**
   * Clears the identity id and every param naming that user, so only the event and its time
   * remain; an entry never takes on a different user. Returns how many entries changed; a second
   * call for the same user changes nothing and returns 0.
   */
  anonymize(identityId: string): Promise<Result<number, PersistenceError>>;
  /** Removes every entry older than `retentionDays` days and returns how many were removed. */
  prune(retentionDays: number): Promise<Result<number, PersistenceError>>;
}

function withoutUser(params: Record<string, string>, identityId: string): Record<string, string> {
  const kept = Object.entries(params).filter(([, value]) => value !== identityId);
  return kept.length === Object.keys(params).length ? params : Object.fromEntries(kept);
}

export async function createAuditPersistence(db: Persistence, now: () => number = Date.now): Promise<Audit> {
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

    async anonymize(identityId) {
      let changed = 0;
      for (let offset = 0; ; offset += CHUNK) {
        const page = await db.findMany<EntryRow>(COLLECTION, {}, { sort: { at: "asc" }, limit: CHUNK, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) {
          const params = withoutUser(row.params, identityId);
          const clearIdentity = row.identityId === identityId;
          if (!clearIdentity && params === row.params) continue;
          const updated = await db.updateOne<EntryRow>(COLLECTION, row.id, { ...(clearIdentity ? { identityId: null } : {}), ...(params === row.params ? {} : { params }) });
          if (isErr(updated)) return updated;
          changed += 1;
        }
        if (page.value.items.length < CHUNK) return ok(changed);
      }
    },

    async prune(retentionDays) {
      const removed = await db.deleteMany(COLLECTION, { at: { lt: now() - retentionDays * DAY_MS } });
      if (isErr(removed)) return removed;
      return ok(removed.value);
    },
  };
}

export function entryFromEventData(data: Record<string, unknown>): AuditEntry {
  const { eventId, event, at, identity, params } = data;
  if (typeof event !== "string" || typeof at !== "number") throw new Error("audit/persistence: payload is not event data (expected event and at)");
  const identityId = typeof identity === "object" && identity !== null && "id" in identity && typeof identity.id === "string" ? identity.id : null;
  return { eventId: typeof eventId === "string" ? eventId : null, event, at, identityId, params: typeof params === "object" && params !== null ? boundaryCast<Record<string, string>>(params, "json") : {} };
}
