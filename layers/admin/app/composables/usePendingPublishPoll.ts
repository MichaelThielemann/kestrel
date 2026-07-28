import { ref } from 'vue'

// A create saves, then the host navigates the editor to the new record's own URL (`/new` → `/<id>`), which
// tears down the editor that issued the save and remounts a fresh one at the real id. The republish it
// kicked off is still in flight, so the ARRIVING editor must POLL the live status (not do a single refresh)
// to catch the "Generating…" → "Live" transition. This module-scoped flag carries that intent across the
// remount: the departing instance sets it on save, the arriving instance reads-and-clears it on mount.
// Client-only ephemeral signal (set in a user save handler, read on mount) — a plain ref is enough; it never
// runs during SSR, so there is no cross-request leakage.
const pending = ref(false)

/** Shared "the next editor mount should poll the live status" flag — see the note above. */
export function usePendingPublishPoll() {
  return pending
}
