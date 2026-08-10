// Every reference in the index whose target is currently deleted or unpublished — the global broken-
// references report. Admin-only (the `references` resource is not in the public set). Derived on read.
// A `null` scan means the index itself could not be read (e.g. record_refs not migrated yet); answering
// `[]` there would report a verified-clean site when nothing was actually checked.
export default defineEventHandler(() => {
  const rows = findBrokenRefs(useDb())
  if (rows === null) throw createError({ statusCode: 503, statusMessage: 'Reference index unavailable' })
  return rows
})
