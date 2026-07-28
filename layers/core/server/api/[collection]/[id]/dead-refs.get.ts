// Per-record stale-reference map for the editor: every reference this record holds that now points at a
// deleted or unpublished target, with its field/block location + reason. Derived on read (auto-clears when
// the link is fixed or the target restored). Fetched non-blocking alongside the editor load, like the
// translations map.
export default defineEventHandler((event) => {
  const collection = requireCollection(event)
  return recordDeadRefs(useDb(), collection, requireId(event))
})
