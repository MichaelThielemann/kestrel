import { watch } from 'vue'
import type { Ref } from 'vue'

/**
 * The shared "mirror a v-model into local reactive state, skip the echo of our own emit, reseed on a
 * genuine external change" guard — used by the block tree, the repeater and the link field.
 *
 * It compares the incoming model against the CURRENT local snapshot, NOT a one-shot "last emitted" token.
 * A captured token goes stale: an external undo→redo (or copy-from-locale) can land back on a
 * previously-emitted value and be wrongly skipped, stranding local state at the pre-undo content. The
 * own-emit echo still short-circuits (the model we just wrote equals our snapshot), while any genuine
 * difference reseeds.
 *
 * @param current  the local serializable snapshot (what we emit / compare against)
 * @param reseed   apply an external model value into local state
 * @param empty    the normalized form of a null/undefined model for the comparison (e.g. `[]` for a list)
 */
export function useEchoGuard<T>(model: Ref<T>, current: () => unknown, reseed: (v: T) => void, empty: unknown = null): void {
  watch(model, (v) => {
    // Own-emit fast path: writing `model.value` to our own reactive snapshot (e.g. `model.value =
    // blocks.value`) resolves both sides to the SAME proxy, so a reference check catches it for free —
    // skipping a full JSON.stringify of a potentially large tree on every keystroke. Excluded from
    // null/undefined so the `empty` normalization below still runs for that case.
    if (v !== null && v !== undefined && v === current()) return
    if (JSON.stringify(v ?? empty) === JSON.stringify(current())) return
    reseed(v)
  })
}
