import { resolveInternalHref } from '../../utils/link-resolve'

// Batch-resolve internal link refs (`?refs=collection:id,collection:id`) to public hrefs for the admin
// block preview. Mirrors the read-path populator, status gate included; only resolved refs are returned,
// so the client renders '#' for a target that is missing or still a draft — same as the generated site.
export default defineEventHandler((event) => {
  const refs = String(getQuery(event).refs ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const data: { collection: string; id: number; href: string }[] = []
  for (const ref of refs) {
    const sep = ref.lastIndexOf(':')
    if (sep <= 0) continue
    const collection = ref.slice(0, sep)
    const id = Number(ref.slice(sep + 1))
    if (!Number.isInteger(id) || id <= 0) continue
    const href = resolveInternalHref(collection, id)
    if (href != null) data.push({ collection, id, href })
  }
  return { data }
})
