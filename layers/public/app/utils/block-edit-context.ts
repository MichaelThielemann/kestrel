import type { InjectionKey, Ref } from 'vue'

// Optional editing context for the public BlockRenderer. On the generated public site the renderer is
// used WITHOUT this context (inject defaults to null) → it renders plain markup, byte-identical to
// before. The admin preview *provides* it, which makes the renderer wrap each block in a clickable
// marker carrying its id — so clicking a block in the preview selects it and the selected block is
// highlighted. This keeps the SSG render path untouched while letting the same component double as a
// selection-aware editor preview.
export interface BlockEditContext {
  /** The currently selected block id (or null for the page root). */
  selectedId: Ref<string | null>
  /** Select a block by id (from a preview click). */
  select: (id: string) => void
}

export const blockEditKey: InjectionKey<BlockEditContext> = Symbol('kestrel.blockEdit')
