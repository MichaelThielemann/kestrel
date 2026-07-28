import { registerPopulator } from '../../../core/server/utils/populate'
import { buildFieldTreePopulator } from '../utils/field-populate'

// The single global row populator: walks a record's fields + block tree and dispatches each field to its
// per-type populator (media / link / richtext / relation), each registered by its owning layer. It recurses
// repeater entries, block props, and slots, so nested references resolve everywhere — not just at the top
// level. Field populators are looked up at read time, so this plugin's order vs the layer plugins that
// register them does not matter.
export default defineNitroPlugin(() => {
  registerPopulator(buildFieldTreePopulator())
})
