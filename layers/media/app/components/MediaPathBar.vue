<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { splitPathInput, joinFolder, displayFolderPath, type LibraryFolder } from '../utils/library'

const props = defineProps<{ folder: string }>()
const emit = defineEmits<{ navigate: [string] }>()

const { t } = useT()

const editing = ref(false)
const draft = ref('')
const suggestions = ref<string[]>([])
let acToken = 0
let acTimer: ReturnType<typeof setTimeout> | undefined

// Non-root path segments, each with its accumulated internal path (for click-to-navigate). The root
// is rendered separately as "/", so the whole bar reads as a real path: "/" · "/a/" · "/a/b/".
const segments = computed(() => {
  const out: { label: string; path: string }[] = []
  let acc = ''
  for (const s of props.folder.split('/').filter(Boolean)) { acc = acc ? `${acc}/${s}` : s; out.push({ label: s, path: acc }) }
  return out
})

function startEdit() { draft.value = displayFolderPath(props.folder); editing.value = true; suggestions.value = [] }
function commit(path: string) { editing.value = false; suggestions.value = []; emit('navigate', path) }
function cancel() { editing.value = false; suggestions.value = [] }

function onInput() { clearTimeout(acTimer); acTimer = setTimeout(fetchSuggestions, 150) }

async function fetchSuggestions() {
  // The typed value is a display path ("/a/su"); resolve its parent to the internal form for the query.
  const { parent, fragment } = splitPathInput(draft.value)
  const my = ++acToken
  try {
    const res = await $fetch<{ folders: LibraryFolder[] }>('/api/media/library', { query: { folder: joinFolder(parent), perPage: 200 } })
    if (my !== acToken) return
    suggestions.value = res.folders
      .filter((f) => f.name.toLowerCase().includes(fragment.toLowerCase()))
      .map((f) => f.path)
  } catch {
    if (my === acToken) suggestions.value = []
  }
}

onUnmounted(() => clearTimeout(acTimer))
</script>

<template>
  <div class="media-pathbar">
    <template v-if="!editing">
      <nav class="media-pathbar__segments" :aria-label="t('mediaPath.navAriaLabel')">
        <button type="button" class="media-pathbar__seg media-pathbar__seg--root" @click="emit('navigate', '')">/</button>
        <template v-for="seg in segments" :key="seg.path">
          <button type="button" class="media-pathbar__seg" @click="emit('navigate', seg.path)">{{ seg.label }}</button>
          <span class="media-pathbar__sep" aria-hidden="true">/</span>
        </template>
      </nav>
      <button type="button" data-test="path-edit" class="media-pathbar__edit" :aria-label="t('mediaPath.editAriaLabel')" @click="startEdit"><KestrelUiIcon name="pencil" :size="14" /></button>
    </template>
    <div v-else class="media-pathbar__editor">
      <input
        v-model="draft"
        class="media-pathbar__input"
        :aria-label="t('mediaPath.inputAriaLabel')"
        @input="onInput"
        @keydown.enter="commit(joinFolder(draft))"
        @keydown.esc="cancel"
      />
      <ul v-if="suggestions.length" class="media-pathbar__suggestions">
        <li v-for="s in suggestions" :key="s">
          <button type="button" @click="commit(s)">{{ displayFolderPath(s) }}</button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.media-pathbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  position: relative;

  &__segments {
    display: flex;
    align-items: center;
    gap: 0;
    flex-wrap: wrap;
  }

  &__seg,
  &__edit {
    background: none;
    border: 0;
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    cursor: pointer;
  }
  &__edit {
    display: inline-flex;
    color: var(--color-text-muted);
    margin-inline-start: var(--space-1);
  }
  &__seg--root {
    color: var(--color-text-muted);
  }

  &__seg:hover {
    background: var(--color-hover);
  }

  &__seg:focus-visible,
  &__edit:focus-visible,
  &__input:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
  }

  &__sep {
    color: var(--color-text-muted);
  }

  &__input {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    min-width: 18rem;
  }

  &__suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: var(--z-dropdown);
    list-style: none;
    margin: var(--space-1) 0 0;
    padding: var(--space-1);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    min-width: 18rem;

    button {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: 0;
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-sm);
      cursor: pointer;

      &:hover {
        background: var(--color-hover);
      }
    }
  }
}
</style>
