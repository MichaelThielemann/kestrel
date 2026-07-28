<script setup lang="ts">
import { ref } from 'vue'
import type { BlockRow, BlockTreeCtx } from '../utils/block-tree'
import { resolveLocalized } from '../../../ui/app/utils/localized'
import BlockTree from './BlockTree.vue'

const props = withDefaults(
  defineProps<{
    blocks: BlockRow[]
    selectedId: string | null
    errorIds: Set<string>
    /** Block ids that hold (or contain) a stale reference — a warning roll-up, parallel to `errorIds`. */
    deadRefIds?: Set<string>
    ctx: BlockTreeCtx
    disabled?: boolean
    /** Set on the parent block + slot when this list is a slot's children; null/null at the page root. */
    parentId?: string | null
    slotName?: string | null
    /** Only the top-level instance renders the selectable "Page" root node. */
    root?: boolean
  }>(),
  { deadRefIds: () => new Set<string>() },
)

const { t, lang } = useT()

const slotNamesOf = (type: string): string[] => props.ctx.byName[type]?.slots ?? []
const labelOf = (block: BlockRow): string => resolveLocalized(props.ctx.byName[block.type]?.label, lang.value) ?? block.type

// Inline "Add block" type picker. The block type is fixed at creation (not switchable afterwards), so
// the only type choice happens here. State is per tree instance, so the root list and each slot keep
// independent pickers. Inline (not teleported) keeps it directly DOM-testable.
const picking = ref(false)
function pick(type: string): void {
  props.ctx.ops.add(props.parentId ?? null, props.slotName ?? null, type)
  picking.value = false
}
</script>

<template>
  <div class="block-tree">
    <button
      v-if="root"
      type="button"
      class="block-tree__root"
      :class="{ 'block-tree__node-label--selected': selectedId === null }"
      :aria-pressed="selectedId === null"
      @click="ctx.ops.select(null)"
    >
      <UiIcon name="file-text" :size="15" class="block-tree__root-icon" />
      <span>{{ t('blocks.page') }}</span>
    </button>

    <p v-if="root && !blocks.length" class="block-tree__empty">{{ t('blocks.empty') }}</p>

    <ul class="block-tree__list">
      <li
        v-for="(block, i) in blocks"
        :key="block.id"
        class="block-tree__node"
        :class="{ 'block-tree__node--selected': selectedId === block.id }"
        :data-type="block.type"
      >
        <div class="block-tree__row">
          <button
            type="button"
            class="block-tree__node-label"
            :class="{ 'block-tree__node-label--selected': selectedId === block.id }"
            :aria-pressed="selectedId === block.id"
            @click="ctx.ops.select(block.id)"
          >
            <span class="block-tree__node-name">{{ labelOf(block) }}</span>
            <span v-if="errorIds.has(block.id)" class="block-tree__badge" role="img" :aria-label="t('blocks.invalid')" :title="t('blocks.invalid')">!</span>
            <UiIcon v-if="deadRefIds.has(block.id)" name="triangle-alert" :size="14" class="block-tree__deadbadge" role="img" :aria-label="t('deadRefs.blockBadge')" :title="t('deadRefs.blockBadge')" />
          </button>
          <div class="block-tree__actions">
            <button type="button" class="block-tree__btn" :disabled="disabled || i === 0" :aria-label="t('blocks.moveUp', { n: i + 1 })" @click="ctx.ops.move(block.id, -1)"><UiIcon name="chevron-up" :size="15" /></button>
            <button type="button" class="block-tree__btn" :disabled="disabled || i === blocks.length - 1" :aria-label="t('blocks.moveDown', { n: i + 1 })" @click="ctx.ops.move(block.id, 1)"><UiIcon name="chevron-down" :size="15" /></button>
            <button type="button" class="block-tree__btn" :disabled="disabled" :aria-label="t('blocks.duplicate', { n: i + 1 })" @click="ctx.ops.duplicate(block.id)"><UiIcon name="copy" :size="15" /></button>
            <button type="button" class="block-tree__btn block-tree__btn--danger" :disabled="disabled" :aria-label="t('blocks.remove', { n: i + 1 })" @click="ctx.ops.remove(block.id)"><UiIcon name="trash" :size="15" /></button>
          </div>
        </div>

        <div v-if="slotNamesOf(block.type).length" class="block-tree__slots">
          <div v-for="name in slotNamesOf(block.type)" :key="name" class="block-tree__slot">
            <span class="block-tree__slot-label">{{ name }}</span>
            <BlockTree
              :blocks="(block.slots?.[name] as BlockRow[]) ?? []"
              :selected-id="selectedId"
              :error-ids="errorIds"
              :dead-ref-ids="deadRefIds"
              :ctx="ctx"
              :disabled="disabled"
              :parent-id="block.id"
              :slot-name="name"
            />
          </div>
        </div>
      </li>
    </ul>

    <div class="block-tree__add">
      <button
        type="button"
        class="block-tree__add-btn"
        :class="{ 'block-tree__add-btn--active': picking }"
        :disabled="disabled"
        aria-haspopup="dialog"
        :aria-expanded="picking"
        @click="picking = true"
      >
        <UiIcon name="plus" :size="15" />
        <span>{{ slotName ? t('blocks.addInto', { slot: slotName }) : t('blocks.add') }}</span>
      </button>

      <!-- The type picker lives in a centered modal (position:fixed) so it escapes the tree pane's
           overflow-y:auto clip; reka's DialogRoot owns Escape/outside-click dismissal + focus restore. -->
      <UiDialog :open="picking" size="lg" :title="t('blocks.pickType')" @update:open="picking = $event">
        <!-- future: category tabs + a search input mount here, above the grid -->
        <ul class="block-tree__picker" :aria-label="t('blocks.pickType')">
          <li v-for="bt in ctx.allowedTypes" :key="bt.name">
            <button
              type="button"
              class="block-tree__picker-item"
              :disabled="disabled"
              :aria-label="t('blocks.addOfType', { type: resolveLocalized(bt.label, lang) ?? bt.name })"
              @click="pick(bt.name)"
            >
              <img v-if="bt.image" :src="bt.image" alt="" loading="lazy" class="block-tree__picker-img" />
              <UiIcon v-else :name="bt.icon ?? 'layout-grid'" :size="24" class="block-tree__picker-icon" />
              <span class="block-tree__picker-label">{{ resolveLocalized(bt.label, lang) ?? bt.name }}</span>
            </button>
          </li>
        </ul>
      </UiDialog>
    </div>
  </div>
</template>

<style lang="scss">
.block-tree {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);

  &__root,
  &__node-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    font: inherit;
    text-align: left;
    text-transform: capitalize;
    color: var(--color-text);
    cursor: pointer;

    &:hover {
      background: var(--color-hover);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
  }

  // The page root reads as a quieter, structural header than the blocks below it.
  &__root {
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
  }
  &__root-icon {
    flex-shrink: 0;
    color: var(--color-text-subtle);
  }

  &__node-label--selected {
    background: var(--color-active, var(--color-surface-2));
    color: var(--color-text);
    font-weight: var(--weight-medium);
    box-shadow: inset 2px 0 0 var(--color-primary);
  }

  &__node-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__empty {
    margin: 0;
    padding: var(--space-1) var(--space-2);
    color: var(--color-text-muted);
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  &__node {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  &__row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-radius: var(--radius-sm);
  }

  &__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    border-radius: var(--radius-full);
    background: var(--color-danger-solid);
    color: var(--color-on-danger);
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
    line-height: 1;
  }

  // Stale-reference warning marker (distinct shape + colour from the red error badge).
  &__deadbadge {
    flex-shrink: 0;
    color: var(--color-warning);
  }

  // Structural controls stay quiet until the row is hovered, focused, or selected — the tree reads as
  // a calm outline, not a control panel. Overlaid (position:absolute) so the hidden bar reserves NO
  // width and the label spans the full row when idle. Kept in the DOM (revealed by :focus-within) so
  // they stay keyboard-reachable; the pointer-events toggle lets idle clicks fall through to the label.
  &__actions {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 1px;
    padding-left: var(--space-5);
    border-radius: var(--radius-sm);
    background: linear-gradient(to right, transparent, var(--color-surface) var(--space-4));
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--motion-fast) var(--ease-standard);
  }
  &__row:hover &__actions,
  &__row:focus-within &__actions,
  &__node--selected > &__row &__actions {
    opacity: 1;
    pointer-events: auto;
  }
  // When the overlay is revealed, reserve room on the label so the name and the validity / stale-ref
  // badges aren't hidden under it (4×1.5rem buttons + a little clearance). Idle rows keep the full width.
  &__row:hover &__node-label,
  &__row:focus-within &__node-label,
  &__node--selected > &__row &__node-label {
    padding-right: 6.25rem;
  }

  &__btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted); /* meaningful icon control at rest → ≥3:1 (SC 1.4.11) */
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease-standard),
      color var(--motion-fast) var(--ease-standard);

    &:hover:not(:disabled) {
      background: var(--color-hover);
      color: var(--color-text);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
    &:disabled {
      opacity: 0.35;
      cursor: default;
    }
    &--danger:hover:not(:disabled) {
      color: var(--color-danger);
    }
  }

  &__slots {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    // Subtle step (~13px/level) so deep nests don't eat the label width; the 1px guide keeps it legible.
    margin: 2px 0 var(--space-1) var(--space-1);
    padding-left: var(--space-2);
    border-left: 1px solid var(--color-border);
  }
  &__slot {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  &__slot-label {
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-muted);
    text-transform: capitalize;
  }

  &__add {
    position: relative;
    margin-top: 2px;
  }
  &__add-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--ease-standard),
      color var(--motion-fast) var(--ease-standard);

    &:hover:not(:disabled) {
      background: var(--color-hover);
      color: var(--color-text);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  // While its picker modal is open, the trigger carries a high-contrast solid-indigo fill so it reads as
  // the active insertion target (UiIcon uses currentColor, so the + glyph flips to on-primary too).
  &__add-btn--active,
  &__add-btn--active:hover:not(:disabled) {
    background: var(--color-primary-solid);
    color: var(--color-on-primary);
  }

  // Tile grid inside the picker dialog body (the dialog provides the card chrome). Structured so a future
  // category-tab row + search input can mount above it. Tiles widen to hold optional preview screenshots.
  &__picker {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
    gap: var(--space-2);
  }
  &__picker-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-xs);
    line-height: 1.2;
    text-align: center;
    text-transform: capitalize;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--color-hover);
      border-color: var(--color-border);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  &__picker-icon {
    color: var(--color-text-subtle);
  }
  &__picker-img {
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  &__picker-label {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
