import { kestrelLayouts } from '#build/kestrel-layouts.mjs'

/** The layout names a page may be assigned, as discovered at build time. */
export function useOfferableLayouts(): string[] {
  return kestrelLayouts
}
