/**
 * Runtime no-op for a block SFC's metadata call — `defineBlock({ label, slots, icon })`. The metadata is
 * read at BUILD time by the SFC extractor (from the same call, statically); at runtime this only exists so
 * the SFC's `<script setup>` doesn't reference an undefined `defineBlock`. Auto-imported in the app so block
 * authors call it without an import (the field factories are auto-imported the same way).
 */
export function defineBlock(_meta?: {
  label?: string | Record<string, string>
  slots?: string[]
  icon?: string
}): void {
  // intentionally empty — see above.
}
