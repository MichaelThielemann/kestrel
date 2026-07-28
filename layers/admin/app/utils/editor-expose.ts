import type { PublishStatusData } from '../composables/usePublishStatus'

/**
 * The handle `CollectionEditor` exposes via `defineExpose` — the header hosts (`[collection]/[id].vue`
 * and `SingletonEditor.vue`) drive Save / undo / preview and read the status ampel through it. ONE typed
 * contract instead of three drifting inline copies: Vue does not type-check a template `ref="editorRef"`
 * against `defineExpose`, so without a shared interface a renamed/removed key (e.g. `previewUrl`) compiles
 * in both hosts and silently becomes `undefined` at runtime. Type both host refs as `EditorExpose | null`.
 */
export interface EditorExpose {
  dirty: boolean
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  hasStatus: boolean
  status: string
  /** The last SAVED publish status (baseline), for the right lamp's draft/published decision. */
  savedStatus: string
  previewUrl: string | null
  pageLike: boolean
  live: PublishStatusData | null
  /** The record's own title (see `recordTitle`), or `''` — the header then shows "Edit {collection} #{id}". */
  recordTitle: string
}
