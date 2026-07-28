// Every reference in the index whose target is currently deleted or unpublished — the global broken-
// references report. Admin-only (the `references` resource is not in the public set). Derived on read.
export default defineEventHandler(() => findBrokenRefs(useDb()) ?? [])
