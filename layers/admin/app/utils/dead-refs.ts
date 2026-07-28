// Client-side shaping of the per-record dead-reference map (the `/dead-refs` endpoint payload) into the
// sets the editor renders: which block nodes carry a stale reference (fed through `errorBearingIds` for
// the tree roll-up, exactly like block errors) and which field keys are stale at a given location. Pure
// + Vue-free so it unit-tests directly (happy-dom can't render the teleported field widgets).

/** One stale reference a record holds, with its field/block location + why it is dead. Wire shape of the
 *  server's `LocatedDeadRef`; kept here so the admin client doesn't import the server (drizzle) module. */
export interface DeadRef {
  field: string
  blockId?: string
  collection: string
  id: number
  reason: 'missing' | 'unpublished'
}

/** Block-node ids that DIRECTLY hold a dead reference — feed into `errorBearingIds` for the tree roll-up. */
export function deadBlockIds(refs: DeadRef[]): Set<string> {
  const out = new Set<string>()
  for (const r of refs) if (r.blockId) out.add(r.blockId)
  return out
}

/** Field keys with a dead reference at a location: a block id, or `null` for the record/page root. */
export function deadFieldsAt(refs: DeadRef[], blockId: string | null): Set<string> {
  const out = new Set<string>()
  for (const r of refs) {
    if (blockId === null ? !r.blockId : r.blockId === blockId) out.add(r.field)
  }
  return out
}
