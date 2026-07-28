import type { InjectionKey, Ref } from 'vue'

/** Editor → field-widget context: lets a widget know the record's id (`'new'` until first save) and whether
 *  it has been saved. A field widget that manages out-of-band storage (e.g. the secure gallery's namespace)
 *  uses this to clean up after an abandoned, never-saved draft. Provided by `CollectionEditor`; mirrors the
 *  `blockEditKey` provide/inject precedent. Auto-imported (no path import needed in an extension). */
export interface RecordEditContext {
  id: Ref<string>
  saved: Ref<boolean>
  /** The editor's reactive record values, so a widget can read SIBLING fields (e.g. the gallery `slug`,
   *  which the proofing overlay uses as the submission key). Reactive object — read `values.<field>`. */
  values: Record<string, unknown>
}

export const recordEditContextKey = Symbol('kestrel.recordEdit') as InjectionKey<RecordEditContext>
