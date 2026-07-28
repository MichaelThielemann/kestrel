import type { CollectionDef } from './defineCollection'

/**
 * A tiny write-event bus (mirrors the populate registry): the CRUD writes emit, and a higher layer
 * subscribes — so `core` stays independent of `public`'s publish concern. The publish plugin registers
 * a listener that classifies the write and enqueues an incremental republish. A listener that throws is
 * swallowed: a publishing failure must never break the actual content write.
 */
export interface WriteEvent {
  def: CollectionDef
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

type WriteListener = (event: WriteEvent) => void

const listeners: WriteListener[] = []

export function registerWriteListener(fn: WriteListener): void {
  listeners.push(fn)
}

export function clearWriteListeners(): void {
  listeners.length = 0
}

export function emitWrite(def: CollectionDef, before: WriteEvent['before'], after: WriteEvent['after']): void {
  for (const fn of listeners) {
    try { fn({ def, before, after }) } catch (error) { console.error('[kestrel] write listener failed:', error) }
  }
}
