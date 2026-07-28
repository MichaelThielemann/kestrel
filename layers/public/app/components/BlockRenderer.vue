<script setup lang="ts">
import { computed, inject, resolveDynamicComponent } from 'vue'
import BlockRenderer from './BlockRenderer.vue'
import { blockEditKey } from '../utils/block-edit-context'

interface BlockNode { id?: string; type: string; props?: Record<string, unknown>; slots?: Record<string, BlockNode[]> }
const props = defineProps<{ blocks: BlockNode[] }>()

// Absent on the public site (plain render); present inside the admin preview (selection-aware wrapper).
const edit = inject(blockEditKey, null)

const pascal = (s: string) => s.replace(/(^|[-_])(\w)/g, (_m, _sep, c: string) => c.toUpperCase())

const items = computed(() =>
  props.blocks.map((block, i) => {
    // A block type with no display component is a content condition, not a programming error: this
    // resolver hands back the bare name for it silently, leaving the message below as the one diagnostic.
    const resolved = resolveDynamicComponent('Blocks' + pascal(block.type))
    const component = typeof resolved === 'string' ? null : resolved
    if (!component && import.meta.dev) console.warn(`[kestrel] no display component for block type "${block.type}"`)
    const { $media, ...fields } = (block.props ?? {}) as Record<string, unknown>
    return { key: block.id ?? i, id: block.id, component, fields, media: $media as Record<string, unknown> | undefined, slots: block.slots }
  }),
)
</script>

<template>
  <template v-for="item in items" :key="item.key">
    <!-- Public render path: no edit context → plain markup, unchanged. -->
    <component :is="item.component" v-if="item.component && !edit" v-bind="item.fields" :media="item.media">
      <!-- Each declared slot's child blocks recurse through the same renderer (props + nested $media). -->
      <template v-for="(slotBlocks, slotName) in item.slots" #[slotName]>
        <BlockRenderer :blocks="slotBlocks" />
      </template>
    </component>
    <!-- Editor preview path: same component, wrapped in a clickable, highlightable marker. `.prevent`
         cancels any anchor navigation from a link-bearing block; `.stop` keeps a nested-block click from
         also selecting its ancestors. The marker is `display: contents` (see KestrelPreviewBridge), so it
         generates no box: the block root stays the parent's real flex/grid item, so flex/grid-item props,
         `gap`, and root-keyed breakpoints render as on the published site. (`>` combinators are unaffected
         either way — the marker element stays in the DOM tree.) -->
    <div
      v-else-if="item.component"
      class="block-edit-marker"
      :class="{ 'block-edit-marker--selected': item.id != null && edit!.selectedId.value === item.id }"
      :data-block-id="item.id"
      @click.prevent.stop="item.id != null && edit!.select(item.id)"
    >
      <component :is="item.component" v-bind="item.fields" :media="item.media">
        <template v-for="(slotBlocks, slotName) in item.slots" #[slotName]>
          <BlockRenderer :blocks="slotBlocks" />
        </template>
      </component>
    </div>
  </template>
</template>
