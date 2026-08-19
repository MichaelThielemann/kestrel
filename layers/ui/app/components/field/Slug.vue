<script setup lang="ts">
import { computed } from 'vue'
import { slugify } from '../../../../core/app/utils/slugify'
import type { FieldComponentProps } from '../../utils/field-component'
import type { FieldOf } from '../../../../core/server/utils/defineCollection'

// Editor widget for the `slug` field type. Shows the (display-only) `prefix` before an editable slug input,
// and normalizes the value to a real slug on blur. Leaving it blank is fine — the server auto-generates it
// from `options.from` (e.g. the title) on save. `options.from`/`prefix` come from the field def.
const props = defineProps<FieldComponentProps>()
const model = defineModel<string | null>()

const opts = computed(() => (props.field.type === 'slug' ? (props.field as FieldOf<'slug'>).options : undefined))
const prefix = computed(() => opts.value?.prefix ?? '')
const fromField = computed(() => opts.value?.from)

// Blur must not turn a null (never-touched, server-auto-generates) slug into '' — that would mark
// an untouched record dirty. Only normalize when there is actual text, and only write if it changes.
function onBlur() {
  const cur = model.value ?? ''
  if (!cur.trim()) return
  const s = slugify(cur)
  if (s && s !== cur) model.value = s
}
</script>

<template>
  <KestrelUiField :id="id" :label="name" :error="error ?? undefined">
    <template #default="f">
      <div class="field-slug" :data-prefixed="!!prefix">
        <span v-if="prefix" class="field-slug__prefix">{{ prefix }}</span>
        <input
          :id="f.id"
          class="field-slug__input"
          type="text"
          :value="model ?? ''"
          :placeholder="fromField ? `auto-generated from ${fromField}` : 'slug'"
          :aria-invalid="f['aria-invalid']"
          :aria-describedby="f['aria-describedby']"
          :disabled="disabled"
          @input="model = ($event.target as HTMLInputElement).value"
          @blur="onBlur"
        />
      </div>
    </template>
  </KestrelUiField>
</template>

<style lang="scss" scoped>
.field-slug {
  display: flex; align-items: stretch; min-width: 0;
  border: 1px solid var(--color-control-border, var(--color-border)); border-radius: var(--radius-md);
  background: var(--color-surface); overflow: hidden;
}
.field-slug__prefix {
  display: inline-flex; align-items: center; padding: var(--space-2) var(--space-3);
  background: var(--color-surface-2); color: var(--color-text-muted);
  border-right: 1px solid var(--color-border); font-size: var(--text-sm); white-space: nowrap;
}
.field-slug__input {
  flex: 1 1 auto; min-width: 0; padding: var(--space-2) var(--space-3);
  border: 0; background: transparent; color: var(--color-text); font: inherit;
  &:focus { outline: none; }
}
.field-slug:focus-within { border-color: var(--color-primary, #6366f1); }
</style>
