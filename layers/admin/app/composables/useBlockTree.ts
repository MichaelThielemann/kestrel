import { ref, computed } from 'vue'
import type { Ref } from 'vue'
import { useEchoGuard } from '../../../ui/app/composables/useEchoGuard'
import type { SerializedBlock } from '@michaelthielemann/kestrel-core'
import {
  type BlockRow,
  findInTree,
  updatePropById,
  removeById,
  removalRetarget,
  moveById,
  duplicateById,
  addBlock,
} from '../utils/block-tree'

/**
 * Reactive state for the 3-pane block editor: one nested `content` tree plus a single shared selection
 * (the stable `block.id`, or `null` for the page root). The tree pane and the fields pane both drive
 * the same instance — the tree selects + does structural ops, the fields pane edits the selected
 * block's props. Every mutation is id-addressed and immutable (see `block-tree.ts`) and re-emits the
 * whole array (so `useEditForm`'s `setField('content', …)` reconciliation still runs). `genId` is
 * injectable for deterministic tests; defaults to `crypto.randomUUID` (the server requires a non-empty id).
 */
export function useBlockTree(
  model: Ref<unknown[] | null | undefined>,
  schemas: Ref<Record<string, SerializedBlock>>,
  genId: () => string = () => crypto.randomUUID(),
  // Routes an emit through the caller's own undo-history capture point instead of a plain `model.value =`
  // assignment, tagged with a per-op coalesce key (see `emit`) — so a structural op landing inside another
  // edit's coalesce window (e.g. a delete right after typing) still gets its own undo step.
  setContent?: (value: unknown[], coalesceAs: string) => void,
) {
  // JSON round-trip (not structuredClone — which throws on Vue reactive proxies): reads through the
  // proxy into detached plain objects. Block content is JSON by definition, so this is lossless here.
  const clone = (v: unknown): BlockRow[] => (Array.isArray(v) ? (JSON.parse(JSON.stringify(v)) as BlockRow[]) : [])

  const blocks = ref<BlockRow[]>(clone(model.value))
  const selectedId = ref<string | null>(null)

  function emit(coalesceAs: string): void {
    if (setContent) setContent(blocks.value, coalesceAs)
    else model.value = blocks.value
  }

  // Echo-guard against the tree's OWN emit (shared primitive): an external change (load / locale copy /
  // undo / redo) differs from the current tree, so it reseeds and drops a now-missing selection to root.
  useEchoGuard(model, () => blocks.value, (v) => {
    blocks.value = clone(v)
    if (selectedId.value !== null && !findInTree(blocks.value, selectedId.value)) selectedId.value = null
  }, [])

  const selectedBlock = computed<BlockRow | null>(() =>
    selectedId.value === null ? null : (findInTree(blocks.value, selectedId.value)?.block ?? null),
  )

  function select(id: string | null): void {
    selectedId.value = id
  }

  function setProp(id: string, key: string, value: unknown): void {
    blocks.value = updatePropById(blocks.value, id, key, value)
    // Coalesces a typing burst into that one field, same as an ordinary text field would.
    emit(`content:prop:${id}:${key}`)
  }

  function remove(id: string): void {
    const retarget = removalRetarget(blocks.value, id)
    blocks.value = removeById(blocks.value, id)
    // Heal the selection whenever it no longer exists — covers removing the selected block itself AND
    // removing an ANCESTOR of it (the whole subtree goes); land on the removed block's sibling/parent.
    if (selectedId.value !== null && !findInTree(blocks.value, selectedId.value)) selectedId.value = retarget
    emit(`content:remove:${id}`)
  }

  function move(id: string, dir: -1 | 1): void {
    blocks.value = moveById(blocks.value, id, dir)
    emit(`content:move:${id}`)
  }

  function duplicate(id: string): void {
    const { tree, newId } = duplicateById(blocks.value, id, genId)
    blocks.value = tree
    selectedId.value = newId
    emit(`content:duplicate:${id}`)
  }

  function add(parentId: string | null, slotName: string | null, type: string): void {
    const { tree, newId } = addBlock(blocks.value, parentId, slotName, type, schemas.value, genId)
    blocks.value = tree
    selectedId.value = newId
    emit(`content:add:${parentId}:${slotName}:${type}`)
  }

  return { blocks, selectedId, selectedBlock, select, setProp, remove, move, duplicate, add }
}
