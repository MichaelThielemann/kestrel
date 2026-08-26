<script setup lang="ts">
import { computed, useSlots } from 'vue'
import type { LinkValue } from '@michaelthielemann/kestrel-core'
import { linkToHref, linkLabel } from '../utils/link-href'

// Generic renderer for the `link` field type, for consumer projects + blocks. Renders an <a> for any
// LinkValue; external links open in a new, isolated tab. Renders nothing for a null/empty value.
const props = defineProps<{ value?: LinkValue | null }>()
const slots = useSlots()
const href = computed(() => linkToHref(props.value))
const isExternal = computed(() => props.value?.type === 'external')
// An unresolved internal link (draft/missing target) falls back to '#' with no target-derived label —
// only render it if it still has an accessible name from elsewhere, or it's a tabbable link to nowhere.
const dead = computed(() => props.value?.type === 'internal' && href.value === '#')
const named = computed(() => !!linkLabel(props.value) || !!slots.default)
</script>

<template>
  <a
    v-if="value && href && (!dead || named)"
    class="kestrel-link"
    :href="href"
    :target="isExternal ? '_blank' : undefined"
    :rel="isExternal ? 'noopener noreferrer' : undefined"
  ><slot>{{ linkLabel(value) }}</slot></a>
</template>
