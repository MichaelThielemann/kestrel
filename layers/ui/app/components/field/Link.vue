<script setup lang="ts">
import { computed } from 'vue'
import UiField from '../ui/Field.vue'
import UiButtonGroup from '../ui/ButtonGroup.vue'
import UiTextInput from '../ui/TextInput.vue'
import LinkInternalPicker from './LinkInternalPicker.vue'
import { useLinkField } from '../../composables/useLinkField'
import type { FieldComponentProps } from '../../utils/field-component'
import type { FieldOf, LinkType, LinkValue } from '@kestrel/core'

const ALL: LinkType[] = ['external', 'email', 'tel', 'internal']
const TYPE_KEYS: Record<LinkType, string> = {
  internal: 'field.link.type_internal',
  external: 'field.link.type_url',
  email: 'field.link.type_email',
  tel: 'field.link.type_phone',
}

const { t } = useT()
const props = defineProps<FieldComponentProps>()
const model = defineModel<LinkValue | null>()

const required = computed(() => !!props.field.required)
const allowed = computed<LinkType[]>(() =>
  props.field.type === 'link' ? ((props.field as FieldOf<'link'>).options?.types ?? ALL) : ALL,
)
const typeOptions = computed(() => allowed.value.map((ltype) => ({ value: ltype, label: t(TYPE_KEYS[ltype]) })))
const internalCollections = computed(() =>
  props.field.type === 'link' ? (props.field as FieldOf<'link'>).options?.collections : undefined,
)

const { currentType, typeModel, url, email, tel, label, collection, recordId, hash } = useLinkField(model, allowed)
</script>

<template>
  <UiField :id="id" :label="name" :error="error" :required="required">
    <template #default="f">
      <UiButtonGroup
        v-if="allowed.length > 1"
        v-model="typeModel"
        :options="typeOptions"
        :disabled="disabled"
        :aria-label="t('field.link.link_type')"
      />

      <template v-if="currentType === 'external'">
        <UiTextInput
          v-model="url"
          type="url"
          :disabled="disabled"
          :placeholder="t('field.link.url_placeholder')"
          v-bind="f"
        />
      </template>
      <template v-else-if="currentType === 'email'">
        <UiTextInput
          v-model="email"
          type="email"
          :disabled="disabled"
          v-bind="f"
        />
      </template>
      <template v-else-if="currentType === 'tel'">
        <UiTextInput
          v-model="tel"
          type="tel"
          :disabled="disabled"
          v-bind="f"
        />
      </template>
      <template v-else>
        <LinkInternalPicker
          v-model:collection="collection"
          v-model:record-id="recordId"
          :collections="internalCollections"
          :locale="locale"
          :disabled="disabled"
          :input-id="f.id"
          :invalid="f['aria-invalid'] === 'true'"
          :describedby="f['aria-describedby']"
          :required="f.required"
        />
        <UiTextInput
          v-model="hash"
          class="ui-link__hash"
          :disabled="disabled"
          :placeholder="t('field.link.hash_placeholder')"
          :aria-label="t('field.link.hash_placeholder')"
        />
      </template>

      <span class="ui-link__label-row">
        <UiTextInput
          v-model="label"
          :disabled="disabled"
          :placeholder="t('field.link.label_placeholder')"
          :aria-label="t('field.link.label_placeholder')"
        />
      </span>
    </template>
  </UiField>
</template>

<style lang="scss">
.ui-link__label-row {
  display: block;
  margin-top: var(--space-1);
}
.ui-link__hash {
  margin-top: var(--space-1);
}
</style>
