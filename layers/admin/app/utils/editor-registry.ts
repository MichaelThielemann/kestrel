import type { Component } from 'vue'

/**
 * Registry of admin editor *bodies* keyed by editor type (the `editor` field on a serialized collection).
 * Mirrors the field-widget registry (`layers/ui/app/utils/field-registry.ts`), one level up: instead of
 * picking a widget per field type, it picks the whole editor body per collection.
 *
 * The built-in `fields` / `blocks` bodies register themselves when the admin editor loads (see
 * `register-editors`); extensions add their own via a `*.client.ts` plugin (auto-discovered through
 * `extends`), exactly like `registerFieldComponent`. The frame — the admin rail (layout) and the record
 * header/toolbar + form state (`CollectionEditor` / the host pages) — stays generic; only this body swaps.
 */
export const editorComponents: Record<string, Component> = {}

export const resolveCollectionEditor = (type: string): Component | undefined => editorComponents[type]

/** Register an editor body for a type. Mutates the singleton; a later call overrides the same type. */
export function registerCollectionEditor(type: string, component: Component): void {
  editorComponents[type] = component
}
