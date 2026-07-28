import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import type { LayoutNode } from '../../../core/server/utils/field-layout'
import type { BlockErrorMap } from './edit-form'
import type { DeadRef } from './dead-refs'

/**
 * The form context `CollectionEditor` (the generic shell) provides to whichever editor **body** the
 * registry resolves (fields · blocks · an extension's, e.g. node-graph). It carries the load-bearing
 * `useEditForm` surface a body needs to read and mutate the record, so a body swaps in without a giant
 * prop list — the same provide/inject seam as `recordEditContextKey`, one level up.
 *
 * Provide it BEFORE the shell's top-level `await` (after an await the setup instance is gone and `provide`
 * silently no-ops), exactly like the record-edit context.
 */
/** Props for the shared page-fields pane. Defined once here so the shell's pre-built bindings and
 *  `PageFieldsPane`'s own `defineProps` stay a single type (a widened `Record` would break the v-bind). */
export interface PageFieldsBindings {
  translatable?: boolean
  collection: string
  id: string
  mode: 'single' | 'multi'
  locale: string
  translations: Record<string, number | null>
  group?: string
  fields: Record<string, FieldDef>
  /** Normalized admin editor layout for the page fields (undefined → one field per row). */
  fieldLayout?: LayoutNode[]
  values: Record<string, unknown>
  errors: Record<string, string>
  deadFields?: Set<string>
  pageLike?: boolean
  seo?: boolean
  status?: boolean
  disabled?: boolean
}

export interface EditorFormContext {
  /** Reactive form values / per-field errors (from `useEditForm`; reactive objects, not refs). */
  values: Record<string, unknown>
  errors: Record<string, string>
  formError: Ref<string>
  blockErrors: Ref<BlockErrorMap>
  /** Route every mutation through this (→ block-error reconciliation, dirty tracking, history). The
   *  optional `coalesceAs` lets a caller (e.g. a block-tree structural op) tag its own undo-history key
   *  instead of coalescing under the bare field name. */
  setField: (name: string, value: unknown, coalesceAs?: string) => void
  locale: Ref<string>
  translations: Ref<Record<string, number | null>>
  translationGroup: Ref<string | undefined>
  deadRefs: Ref<DeadRef[]>
  saving: Ref<boolean>
  mode: Ref<'multi' | 'single'>
  translatable: Ref<boolean>
  pageLike: Ref<boolean>
  hasSeo: Ref<boolean>
  hasStatus: Ref<boolean>
  blocksAllowed: Ref<string[] | undefined>
  /** Collection (page-root) fields as `FieldDef`s, ready for the field Renderer. */
  renderable: ComputedRef<Record<string, FieldDef>>
  /** The record's localized public URL (saved pageLike record with a path), or null (new/unsaved,
   *  non-pageLike). The shell computes it once for the header's open-in-new-tab AND the live preview. */
  previewUrl: ComputedRef<string | null>
  undo: () => void
  redo: () => void
  applyFrom: (row: Record<string, unknown>) => void
  /** Pre-bound props/handlers for the shared page-fields pane, rendered by both the fields and blocks
   *  bodies (identical binding, differing only in layout chrome). */
  pageFieldsBindings: ComputedRef<PageFieldsBindings>
  pageFieldsHandlers: Record<string, (...args: never[]) => void>
  /** A body registers how to reveal a validation failure (e.g. the blocks body focuses the offending
   *  block). The shell calls it on a failed save, staying agnostic of the body's internals. */
  registerRevealError: (fn: () => void) => void
}

export const editorFormContextKey = Symbol('kestrel.editorForm') as InjectionKey<EditorFormContext>

/** Inject the editor form context inside a body component; throws if used outside `CollectionEditor`. */
export function useEditorFormContext(): EditorFormContext {
  const ctx = inject(editorFormContextKey)
  if (!ctx) throw new Error('[kestrel] editor body used outside CollectionEditor (no editor form context)')
  return ctx
}
