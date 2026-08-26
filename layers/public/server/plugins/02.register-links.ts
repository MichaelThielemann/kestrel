import { registerFieldPopulator } from '@michaelthielemann/kestrel-core'
import { buildLinkFieldPopulators, resolveInternalHref } from '@michaelthielemann/kestrel-publishing'

// Resolve internal links to the target record's localized public path at read time (page-like targets;
// external/email/tel pass through). The resolver IS status-gated: a link to a DRAFT resolves to nothing and
// bakes `'#'`, so an unpublished slug never reaches published HTML. The href therefore encodes availability,
// which is why flipping a target's status re-renders its referrers; the editor warns about the resulting
// draft/dead links separately. (See link-resolve.ts.)
//
// Registered as `link` + `richtext` per-type populators; the shared field-tree walker dispatches them over
// top-level fields, block props, slots, and repeater entries.
export default defineNitroPlugin(() => {
  const { link, richtext } = buildLinkFieldPopulators(resolveInternalHref)
  registerFieldPopulator('link', link)
  registerFieldPopulator('richtext', richtext)
})
