import { registerFieldPopulator } from '../../../core/server/utils/populate'
import { buildLinkFieldPopulators } from '../utils/populate-links'
import { resolveInternalHref } from '../utils/link-resolve'

// Resolve internal links to the target record's localized public path at read time (page-like targets;
// external/email/tel pass through). NOTE: the resolver does NOT status-gate the target — a link to a DRAFT
// emits the draft's real (not-yet-generated) path, disclosing its slug and shipping a 404 until publish. This
// is deliberate: it keeps links stable without re-rendering every referrer when a target's status flips, and
// the editor warns about draft/dead links instead. (See link-resolve.ts for the rationale.)
//
// Registered as `link` + `richtext` per-type populators; the shared field-tree walker dispatches them over
// top-level fields, block props, slots, and repeater entries.
export default defineNitroPlugin(() => {
  const { link, richtext } = buildLinkFieldPopulators(resolveInternalHref)
  registerFieldPopulator('link', link)
  registerFieldPopulator('richtext', richtext)
})
