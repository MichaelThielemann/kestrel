<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import UiButton from './Button.vue'
import UiIcon from './Icon.vue'
import UiSelect from './Select.vue'
import UiTextInput from './TextInput.vue'
import LinkInternalPicker from '../field/LinkInternalPicker.vue'
import type { IconName } from '../../utils/icons'
import { richtextLinkHref, parseRichtextLinkHref } from '@kestrel/core/client'

const props = defineProps<{ editor: Editor | undefined; locale?: string; disabled?: boolean }>()

interface Item {
  name: string
  label: string
  icon: IconName
  run: (e: Editor) => void
  active?: (e: Editor) => boolean
  disabled?: (e: Editor) => boolean
}

const { t } = useT()

const MARKS = computed((): Item[] => [
  { name: 'bold', label: t('richtext.bold'), icon: 'bold', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { name: 'italic', label: t('richtext.italic'), icon: 'italic', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { name: 'underline', label: t('richtext.underline'), icon: 'underline', run: (e) => e.chain().focus().toggleUnderline().run(), active: (e) => e.isActive('underline') },
  { name: 'strike', label: t('richtext.strikethrough'), icon: 'strikethrough', run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive('strike') },
  { name: 'code', label: t('richtext.inlineCode'), icon: 'code', run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive('code') },
  { name: 'highlight', label: t('richtext.highlight'), icon: 'highlighter', run: (e) => e.chain().focus().toggleHighlight().run(), active: (e) => e.isActive('highlight') },
  { name: 'subscript', label: t('richtext.subscript'), icon: 'subscript', run: (e) => e.chain().focus().toggleSubscript().run(), active: (e) => e.isActive('subscript') },
  { name: 'superscript', label: t('richtext.superscript'), icon: 'superscript', run: (e) => e.chain().focus().toggleSuperscript().run(), active: (e) => e.isActive('superscript') },
])
const BLOCKS = computed((): Item[] => [
  { name: 'bulletList', label: t('richtext.bulletList'), icon: 'list', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { name: 'orderedList', label: t('richtext.orderedList'), icon: 'list-ordered', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { name: 'blockquote', label: t('richtext.blockquote'), icon: 'quote', run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
  { name: 'codeBlock', label: t('richtext.codeBlock'), icon: 'square-code', run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive('codeBlock') },
  { name: 'horizontalRule', label: t('richtext.horizontalRule'), icon: 'minus', run: (e) => e.chain().focus().setHorizontalRule().run() },
])
const ALIGN = computed((): Item[] => [
  { name: 'left', label: t('richtext.alignLeft'), icon: 'align-left', run: (e) => e.chain().focus().setTextAlign('left').run(), active: (e) => e.isActive({ textAlign: 'left' }) },
  { name: 'center', label: t('richtext.alignCenter'), icon: 'align-center', run: (e) => e.chain().focus().setTextAlign('center').run(), active: (e) => e.isActive({ textAlign: 'center' }) },
  { name: 'right', label: t('richtext.alignRight'), icon: 'align-right', run: (e) => e.chain().focus().setTextAlign('right').run(), active: (e) => e.isActive({ textAlign: 'right' }) },
  { name: 'justify', label: t('richtext.justify'), icon: 'align-justify', run: (e) => e.chain().focus().setTextAlign('justify').run(), active: (e) => e.isActive({ textAlign: 'justify' }) },
])
const EXTRA = computed((): Item[] => [
  { name: 'clear', label: t('richtext.clearFormatting'), icon: 'eraser', run: (e) => e.chain().focus().unsetAllMarks().clearNodes().run() },
  { name: 'undo', label: t('richtext.undo'), icon: 'undo', run: (e) => e.chain().focus().undo().run(), disabled: (e) => !e.can().undo() },
  { name: 'redo', label: t('richtext.redo'), icon: 'redo', run: (e) => e.chain().focus().redo().run(), disabled: (e) => !e.can().redo() },
])

const BLOCK_OPTIONS = computed(() => [
  { label: t('richtext.paragraph'), value: 'p' },
  { label: t('richtext.heading1'), value: 'h1' }, { label: t('richtext.heading2'), value: 'h2' }, { label: t('richtext.heading3'), value: 'h3' },
  { label: t('richtext.heading4'), value: 'h4' }, { label: t('richtext.heading5'), value: 'h5' }, { label: t('richtext.heading6'), value: 'h6' },
])

// Re-render the toolbar on every editor transaction so active/disabled states stay live.
const tick = ref(0)
watch(() => props.editor, (editor, _old, onCleanup) => {
  if (!editor) return
  const bump = () => { tick.value++ }
  editor.on('transaction', bump)
  onCleanup(() => { editor.off('transaction', bump) })
}, { immediate: true })

const blockValue = computed(() => {
  void tick.value
  const e = props.editor
  if (!e) return 'p'
  for (let l = 1; l <= 6; l++) if (e.isActive('heading', { level: l })) return `h${l}`
  return 'p'
})
function onBlock(v: string | null | undefined) {
  const e = props.editor
  if (!e || !v) return
  if (v === 'p') e.chain().focus().setParagraph().run()
  else e.chain().focus().toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 | 4 | 5 | 6 }).run()
}

const linkOpen = ref(false)
const linkUrl = ref('')
function toggleLink() {
  const e = props.editor!
  if (e.isActive('link')) { e.chain().focus().unsetLink().run(); return }
  linkInternalOpen.value = false
  linkUrl.value = (e.getAttributes('link').href as string) ?? ''
  linkOpen.value = true
}
function applyLink() {
  const e = props.editor!
  const href = linkUrl.value.trim()
  if (href) e.chain().focus().extendMarkRange('link').setLink({ href }).run()
  linkOpen.value = false
  linkUrl.value = ''
}

// Internal links: pick a record, store it as a `kestrel:<collection>:<id>` marker on a normal link
// mark (resolved to the real localized path at read time / in the preview).
const linkInternalOpen = ref(false)
const pickCollection = ref<string | null>(null)
const pickRecordId = ref<number | null>(null)
function toggleInternalLink() {
  linkOpen.value = false
  const opening = !linkInternalOpen.value
  linkInternalOpen.value = opening
  if (!opening) return
  // Prefill from the link under the cursor: an existing internal marker re-selects its record (the
  // picker loads + highlights it); an external/absent link opens the picker blank.
  const parsed = parseRichtextLinkHref(props.editor!.getAttributes('link').href as string | undefined)
  pickCollection.value = parsed?.collection ?? null
  pickRecordId.value = parsed?.id ?? null
}
function applyInternalLink() {
  const e = props.editor!
  if (pickCollection.value && pickRecordId.value != null) {
    e.chain().focus().extendMarkRange('link').setLink({ href: richtextLinkHref(pickCollection.value, pickRecordId.value) }).run()
  }
  linkInternalOpen.value = false
  pickCollection.value = null
  pickRecordId.value = null
}
</script>

<template>
  <div v-if="editor" class="ui-rt-toolbar" :data-rev="tick">
    <UiSelect
      class="ui-rt-toolbar__block"
      :model-value="blockValue"
      :options="BLOCK_OPTIONS"
      :aria-label="t('richtext.blockType')"
      :disabled="disabled"
      @update:model-value="onBlock"
    />

    <div class="ui-rt-toolbar__group">
      <UiButton
        v-for="item in MARKS" :key="item.name"
        type="button" size="sm" variant="ghost"
        :class="{ 'rt-on': item.active!(editor) }"
        :aria-label="item.label"
        :aria-pressed="item.active!(editor) ? 'true' : 'false'"
        :disabled="disabled"
        @click="item.run(editor)"
      ><UiIcon :name="item.icon" :size="16" /></UiButton>
    </div>

    <div class="ui-rt-toolbar__group">
      <UiButton
        type="button" size="sm" variant="ghost"
        :class="{ 'rt-on': editor.isActive('link') }"
        :aria-label="t('richtext.link')"
        :aria-pressed="editor.isActive('link') ? 'true' : 'false'"
        :disabled="disabled"
        @click="toggleLink"
      ><UiIcon name="link" :size="16" /></UiButton>
      <UiButton
        type="button" size="sm" variant="ghost"
        :class="{ 'rt-on': linkInternalOpen }"
        :aria-label="t('richtext.linkInternal')"
        :aria-pressed="linkInternalOpen ? 'true' : 'false'"
        :disabled="disabled"
        @click="toggleInternalLink"
      ><UiIcon name="link-2" :size="16" /></UiButton>
    </div>

    <div class="ui-rt-toolbar__group">
      <UiButton
        v-for="item in BLOCKS" :key="item.name"
        type="button" size="sm" variant="ghost"
        :class="{ 'rt-on': item.active && item.active(editor) }"
        :aria-label="item.label"
        :aria-pressed="item.active ? (item.active(editor) ? 'true' : 'false') : undefined"
        :disabled="disabled"
        @click="item.run(editor)"
      ><UiIcon :name="item.icon" :size="16" /></UiButton>
    </div>

    <div class="ui-rt-toolbar__group">
      <UiButton
        v-for="item in ALIGN" :key="item.name"
        type="button" size="sm" variant="ghost"
        :class="{ 'rt-on': item.active!(editor) }"
        :aria-label="item.label"
        :aria-pressed="item.active!(editor) ? 'true' : 'false'"
        :disabled="disabled"
        @click="item.run(editor)"
      ><UiIcon :name="item.icon" :size="16" /></UiButton>
    </div>

    <div class="ui-rt-toolbar__group">
      <UiButton
        v-for="item in EXTRA" :key="item.name"
        type="button" size="sm" variant="ghost"
        :aria-label="item.label"
        :disabled="disabled || (item.disabled ? item.disabled(editor) : false)"
        @click="item.run(editor)"
      ><UiIcon :name="item.icon" :size="16" /></UiButton>
    </div>

    <div v-if="linkOpen" class="ui-rt-toolbar__link">
      <UiTextInput v-model="linkUrl" type="url" :placeholder="t('richtext.urlPlaceholder')" :aria-label="t('richtext.linkUrl')" @keydown.enter.prevent="applyLink" />
      <UiButton type="button" size="sm" variant="primary" @click="applyLink">{{ t('richtext.apply') }}</UiButton>
    </div>

    <div v-if="linkInternalOpen" class="ui-rt-toolbar__link">
      <LinkInternalPicker v-model:collection="pickCollection" v-model:record-id="pickRecordId" :locale="locale ?? 'en'" />
      <UiButton type="button" size="sm" variant="primary" :disabled="pickRecordId == null" @click="applyInternalLink">{{ t('richtext.apply') }}</UiButton>
    </div>
  </div>
</template>

<style lang="scss">
.ui-rt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);

  &__group {
    display: inline-flex;
    gap: var(--space-1);
  }
  &__block {
    width: auto;
    min-width: 8rem;
  }
  &__link {
    display: flex;
    gap: var(--space-2);
    flex-basis: 100%;
    align-items: center;
  }

  &__group .ui-button.rt-on {
    background: var(--color-active, var(--color-surface-2));
    color: var(--color-text);

    &:hover:not(:disabled) {
      background: var(--color-active, var(--color-surface-2));
    }
    .ui-icon {
      color: var(--color-primary);
    }
  }
}
</style>
