import { registerCollectionEditor } from './editor-registry'
import FieldsBody from '../components/FieldsBody.vue'
import BlocksBody from '../components/BlocksBody.vue'

// Built-in editor bodies. Registered as an import side-effect (CollectionEditor imports this module), so
// they are present before any editor renders — the same guarantee the field registry's static map gives.
// Extensions add their own types via a `*.client.ts` plugin (auto-discovered through `extends`).
registerCollectionEditor('fields', FieldsBody)
registerCollectionEditor('blocks', BlocksBody)
