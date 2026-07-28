// Admin-only (default-deny applies to /api/**): the per-block field schemas the editor needs to
// render block inputs. `?allowed=a,b` restricts to a collection's allowed block types.
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const allowed = typeof q.allowed === 'string' && q.allowed.length
    ? q.allowed.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined
  return { data: allBlocks(allowed).map(serializeBlock) }
})
