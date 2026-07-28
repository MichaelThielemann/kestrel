<script setup lang="ts">
import { humanizeSize, itemKey, type LibraryItem } from '../utils/library'
const { t } = useT()
const props = defineProps<{ items: LibraryItem[]; isSelected: (item: LibraryItem) => boolean; dropTargetPath?: string | null; sort?: string; parentPath?: string | null; upLabel?: string }>()
const emit = defineEmits<{ navigate: [string]; select: [LibraryItem, { toggle: boolean; range: boolean }]; open: [LibraryItem]; dragstart: [LibraryItem, DragEvent]; dragend: []; sort: [string] }>()
const arrow = (field: string) => (props.sort === field ? ' ▲' : props.sort === `-${field}` ? ' ▼' : '')
const ariaSort = (field: string): 'ascending' | 'descending' | 'none' => (props.sort === field ? 'ascending' : props.sort === `-${field}` ? 'descending' : 'none')
const mods = (e: MouseEvent) => ({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
// Plain click opens the folder; modifier-click selects it so folders can join the selection.
function onFolder(item: LibraryItem, path: string, e: MouseEvent | KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) emit('select', item, mods(e as MouseEvent))
  else emit('navigate', path)
}
function onFile(item: LibraryItem, e: MouseEvent | KeyboardEvent) { emit('select', item, mods(e as MouseEvent)) }
const dims = (f: { width?: number; height?: number }) => (f.width && f.height ? `${f.width}×${f.height}` : '—')
</script>

<template>
  <table class="media-table">
    <thead>
      <tr>
        <th scope="col" :aria-sort="ariaSort('name')"><button type="button" class="media-table__sort" @click="emit('sort', 'name')">{{ t('media.colName') }}<span aria-hidden="true">{{ arrow('name') }}</span></button></th>
        <th scope="col" :aria-sort="ariaSort('type')"><button type="button" class="media-table__sort" @click="emit('sort', 'type')">{{ t('media.colType') }}<span aria-hidden="true">{{ arrow('type') }}</span></button></th>
        <th scope="col" :aria-sort="ariaSort('size')"><button type="button" class="media-table__sort" @click="emit('sort', 'size')">{{ t('media.colSize') }}<span aria-hidden="true">{{ arrow('size') }}</span></button></th>
        <th scope="col">{{ t('media.colDimensions') }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="parentPath != null" class="media-table__row media-table__row--up" data-test="row-folder-up"
        tabindex="0" :aria-label="upLabel"
        @click="emit('navigate', parentPath)" @keydown.enter.space.prevent="emit('navigate', parentPath)">
        <td><span aria-hidden="true"><UiIcon name="folder" :size="15" /></span> ..</td>
        <td>{{ t('media.typeFolder') }}</td><td>—</td><td>—</td>
      </tr>
      <tr v-for="item in items" :key="itemKey(item)" class="media-table__row"
        :class="{ 'is-selected': isSelected(item), 'is-drop-target': item.type === 'folder' && item.folder.path === dropTargetPath }"
        :aria-selected="isSelected(item)" tabindex="0"
        :data-drop-folder="item.type === 'folder' ? item.folder.path : undefined"
        :data-file-id="item.type === 'file' ? item.file.id : undefined"
        :data-test="item.type === 'folder' ? `row-folder-${item.folder.path}` : `row-file-${item.file.id}`"
        draggable="true"
        @click="item.type === 'folder' ? onFolder(item, item.folder.path, $event) : onFile(item, $event)"
        @dblclick="item.type === 'file' && emit('open', item)"
        @keydown.enter.prevent="item.type === 'folder' ? onFolder(item, item.folder.path, $event) : emit('open', item)"
        @keydown.space.prevent="item.type === 'folder' ? emit('select', item, { toggle: true, range: false }) : onFile(item, $event)"
        @dragstart="(e) => emit('dragstart', item, e)"
        @dragend="emit('dragend')">
        <template v-if="item.type === 'folder'">
          <td><span aria-hidden="true"><UiIcon name="folder" :size="15" /></span> {{ item.folder.name }}</td>
          <td>{{ t('media.typeFolder') }}</td><td>{{ item.folder.size != null ? humanizeSize(item.folder.size) : '—' }}</td><td>—</td>
        </template>
        <template v-else>
          <td><slot name="file-badge" :file="item.file" />{{ item.file.filename }}</td>
          <td>{{ item.file.mime }}</td>
          <td>{{ humanizeSize(item.file.size) }}</td>
          <td>{{ dims(item.file) }}</td>
        </template>
      </tr>
    </tbody>
  </table>
</template>

<style lang="scss" scoped>
.media-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.media-table th, .media-table td { text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--color-border); }
.media-table th { color: var(--color-text-muted); font-weight: var(--weight-medium); }
.media-table__sort { display: inline-flex; align-items: center; gap: var(--space-1); background: none; border: 0; padding: 0; font: inherit; font-weight: var(--weight-medium); color: var(--color-text-muted); cursor: pointer; }
.media-table__sort:hover { color: var(--color-text); }
.media-table__sort:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.media-table__row { cursor: pointer; }
.media-table__row:hover { background: var(--color-hover); }
.media-table__row.is-selected { background: var(--color-active); box-shadow: inset 2px 0 0 var(--color-primary); }
.media-table__row.is-drop-target { outline: 2px dashed var(--color-primary); outline-offset: -2px; background: var(--color-surface); }
.media-table__row:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
</style>
