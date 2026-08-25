<script setup lang="ts">
import type { SerializedBlock } from '@kestrel/core'
import type { BlockTreeCtx } from '../utils/block-tree'

// The page-builder editor body: hierarchy · live preview · contextual fields. All form state comes from
// the editor form context (CollectionEditor); the block-specific machinery lives here.
const { t } = useT()
const ctx = useEditorFormContext()
const { values, setField, blockErrors, deadRefs, saving, locale, blocksAllowed } = ctx

// Block registry. This body mounts only for a blocks-enabled collection, so the load always runs.
const { load } = useBlocks()
const all = await load()
const byName = computed<Record<string, SerializedBlock>>(() => Object.fromEntries(all.map((b) => [b.name, b])))
const allowedTypes = computed(() => (blocksAllowed.value?.length ? all.filter((b) => blocksAllowed.value!.includes(b.name)) : all))

// One writable view of `content` so every tree mutation routes back through `setField` (→ block-error
// reconciliation).
const content = computed<unknown[]>({
  get: () => (values.content as unknown[]) ?? [],
  set: (v) => setField('content', v),
})
const tree = useBlockTree(content, byName, undefined, (v, coalesceAs) => setField('content', v, coalesceAs))
const { selectedId, selectedBlock } = tree

// Tree badges: a node is flagged if it (or any descendant, by roll-up) has an error.
const errorIds = computed(() => errorBearingIds(tree.blocks.value, new Set(Object.keys(blockErrors.value))))
// Stale-reference warnings (derived on read): the same ancestor roll-up as errors, plus the per-field set
// for the selected block. (The page-root dead fields live on the shell's shared page-fields bindings.)
const deadRefIds = computed(() => errorBearingIds(tree.blocks.value, deadBlockIds(deadRefs.value)))
const blockDeadFields = computed(() => deadFieldsAt(deadRefs.value, selectedId.value))

// Stable config + ops threaded through the recursive tree.
const treeCtx: BlockTreeCtx = {
  byName: byName.value,
  allowedTypes: allowedTypes.value,
  ops: { select: tree.select, add: tree.add, remove: tree.remove, move: tree.move, duplicate: tree.duplicate },
}

// On a failed save: jump to the first offending block so its fields are in view; if none, deselect so the
// page-fields pane remounts and its inline error shows. Registered with the shell, which invokes it.
ctx.registerRevealError(() => {
  const firstBlock = Object.keys(blockErrors.value)[0]
  if (firstBlock) tree.select(firstBlock)
  else if (selectedId.value) tree.select(null)
})

// Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redo — for the block editor. Skipped while editing text
// (input/textarea/contenteditable) so the field's / richtext's own native undo keeps working.
function onKeydown(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey)) return
  const k = e.key.toLowerCase()
  const isRedo = k === 'y' || (k === 'z' && e.shiftKey)
  const isUndo = k === 'z' && !e.shiftKey
  if (!isUndo && !isRedo) return
  const el = e.target as HTMLElement | null
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
  e.preventDefault()
  if (isRedo) ctx.redo()
  else ctx.undo()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="editor3">
    <nav class="editor3__tree" :aria-label="t('blocks.treeLabel')">
      <div class="editor3__tree-head">
        <p class="editor3__pane-label">{{ t('blocks.treeLabel') }}</p>
      </div>
      <KestrelBlockTree
        root
        :blocks="tree.blocks.value"
        :selected-id="selectedId"
        :error-ids="errorIds"
        :dead-ref-ids="deadRefIds"
        :ctx="treeCtx"
        :disabled="saving"
      />
    </nav>

    <aside class="editor3__preview" :aria-label="t('preview.ariaLabel')">
      <!-- The "Preview" pane label is folded into BlockPreview's own toolbar row (single-line header). -->
      <KestrelBlockPreview :content="content" :locale="locale" :selected-id="selectedId" @select="tree.select" />
    </aside>

    <section class="editor3__fields" :aria-label="t('blocks.fieldsLabel')">
      <!-- A block is selected → its fields; otherwise the page (collection) fields + locale switcher. -->
      <KestrelBlockFields
        v-if="selectedBlock"
        :block="selectedBlock"
        :def="byName[selectedBlock.type]"
        :locale="locale"
        :errors="selectedId ? blockErrors[selectedId] : undefined"
        :dead-fields="blockDeadFields"
        :disabled="saving"
        @update="(k, v) => selectedId && tree.setProp(selectedId, k, v)"
      />
      <template v-else>
        <p class="editor3__pane-label">{{ t('blocks.pageFields') }}</p>
        <KestrelPageFieldsPane v-bind="ctx.pageFieldsBindings.value" v-on="ctx.pageFieldsHandlers" />
      </template>
    </section>
  </div>
</template>

<style lang="scss">
.editor3 {
  display: grid;
  grid-template-columns: minmax(0, 17rem) minmax(0, 1fr) minmax(0, 22rem);
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;

  @media (max-width: 1100px) {
    grid-template-columns: 1fr;
    // Stacked single column: the grid scrolls as a whole; panes grow to their content.
    overflow-y: auto;
    .editor3__tree,
    .editor3__preview,
    .editor3__fields {
      overflow: visible;
    }
  }

  &__pane-label {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
  }

  &__tree-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  // Each pane fills the column height and scrolls independently. Tree + fields are the side panels;
  // the preview in the middle is the canvas they act on.
  &__tree,
  &__fields,
  &__preview {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
  }
  &__fields {
    gap: var(--space-4);
  }
  &__preview {
    background: var(--color-bg);
  }
}
</style>
