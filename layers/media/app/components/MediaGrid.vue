<script setup lang="ts">
import { itemKey, humanizeSize, type LibraryFile, type LibraryItem } from '../utils/library'
defineProps<{ items: LibraryItem[]; isSelected: (item: LibraryItem) => boolean; dropTargetPath?: string | null; parentPath?: string | null; upLabel?: string }>()
const emit = defineEmits<{ navigate: [string]; select: [LibraryItem, { toggle: boolean; range: boolean }]; open: [LibraryItem]; dragstart: [LibraryItem, DragEvent]; dragend: [] }>()
const mods = (e: MouseEvent) => ({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
// Plain click opens the folder; modifier-click selects it so folders can join the selection.
function onFolder(item: LibraryItem, path: string, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) emit('select', item, mods(e))
  else emit('navigate', path)
}
function onFile(item: LibraryItem, e: MouseEvent) { emit('select', item, mods(e)) }
const ext = (filename: string) => (filename.split('.').pop() ?? '').toUpperCase()
// Hover meta: dimensions (when known) · size — the same facts the table view shows in its columns.
function fileMeta(f: LibraryFile): string {
  const parts: string[] = []
  if (f.width && f.height) parts.push(`${f.width}×${f.height}`)
  parts.push(humanizeSize(f.size))
  return parts.join(' · ')
}
</script>

<template>
  <ul class="media-grid">
    <li v-if="parentPath != null" class="media-grid__cell">
      <!-- Pure up-navigation; not selectable/draggable (kept out of `items`). -->
      <button type="button" class="media-grid__tile media-grid__tile--folder" data-test="folder-up"
        :aria-label="upLabel" @click="emit('navigate', parentPath)">
        <span class="media-grid__thumb-wrap">
          <span class="media-grid__thumb media-grid__thumb--folder" aria-hidden="true"><KestrelUiIcon name="folder" :size="40" /></span>
        </span>
        <span class="media-grid__name">..</span>
      </button>
    </li>
    <li v-for="item in items" :key="itemKey(item)" class="media-grid__cell">
      <button v-if="item.type === 'folder'" type="button" class="media-grid__tile media-grid__tile--folder"
        :data-test="`folder-${item.folder.path}`" :aria-pressed="isSelected(item)"
        :data-drop-folder="item.folder.path"
        :class="{ 'is-selected': isSelected(item), 'is-drop-target': item.folder.path === dropTargetPath }"
        draggable="true"
        @click="onFolder(item, item.folder.path, $event)"
        @keydown.space.prevent="emit('select', item, { toggle: true, range: false })"
        @dragstart="(e) => emit('dragstart', item, e)"
        @dragend="emit('dragend')">
        <span class="media-grid__thumb-wrap">
          <span class="media-grid__thumb media-grid__thumb--folder" aria-hidden="true"><KestrelUiIcon name="folder" :size="40" /></span>
          <span v-if="item.folder.size != null" class="media-grid__meta" aria-hidden="true">{{ humanizeSize(item.folder.size) }}</span>
        </span>
        <span class="media-grid__name">{{ item.folder.name }}</span>
      </button>
      <button v-else type="button" class="media-grid__tile media-grid__tile--file"
        :data-test="`file-${item.file.id}`" :aria-pressed="isSelected(item)"
        :data-file-id="item.file.id"
        :class="{ 'is-selected': isSelected(item) }"
        draggable="true"
        @click="onFile(item, $event)"
        @dblclick="emit('open', item)"
        @keydown.enter.prevent="emit('open', item)"
        @dragstart="(e) => emit('dragstart', item, e)"
        @dragend="emit('dragend')">
        <span class="media-grid__thumb-wrap">
          <!-- Show a thumbnail for any image WITH a source: media files carry `srcset` (responsive derivatives),
               while a consumer feeding object-URLs (e.g. the secure gallery) has only `src`. Non-images → badge. -->
          <KestrelMediaThumb v-if="item.file.mime?.startsWith('image/') && (item.file.srcset || item.file.src)" class="media-grid__thumb"
            :src="item.file.src" :srcset="item.file.srcset" sizes="160px" :alt="item.file.alt ?? item.file.filename" :thumbhash="item.file.thumbhash" />
          <span v-else class="media-grid__badge" aria-hidden="true">{{ ext(item.file.filename) }}</span>
          <span class="media-grid__meta" aria-hidden="true">{{ fileMeta(item.file) }}</span>
          <!-- Optional per-file overlay (e.g. proofing colour flags). Empty by default → nothing rendered. -->
          <span class="media-grid__overlay"><slot name="file-overlay" :file="item.file" /></span>
        </span>
        <span class="media-grid__name">{{ item.file.filename }}</span>
      </button>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: var(--space-3); list-style: none; padding: 0; margin: 0; }
.media-grid__tile { display: flex; flex-direction: column; gap: var(--space-2); width: 100%; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-2); cursor: pointer; text-align: left; }
.media-grid__tile:hover { border-color: var(--color-border-strong); }
// Selection/drop/focus rings are INSET (border-color + inset shadow, or a negative outline-offset) so a
// scrolling ancestor never clips them — matches MediaTable. An outset outline (positive offset) on an
// edge tile is sliced off by the library's overflow.
.media-grid__tile.is-selected { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
.media-grid__tile.is-drop-target { outline: 2px dashed var(--color-primary); outline-offset: -2px; background: var(--color-surface); }
.media-grid__tile:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.media-grid__thumb-wrap { position: relative; width: 100%; }
.media-grid__overlay { position: absolute; top: var(--space-1); left: var(--space-1); display: flex; gap: 2px; pointer-events: none; }
.media-grid__thumb { aspect-ratio: 1; width: 100%; object-fit: cover; border-radius: var(--radius-sm); background: var(--color-bg); display: block; }
.media-grid__thumb--folder { display: grid; place-items: center; color: var(--color-text-subtle); }
.media-grid__badge { display: grid; place-items: center; aspect-ratio: 1; width: 100%; border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text-muted); font-weight: var(--weight-bold); }
// Hover/focus reveal of the dimensions · size caption, overlaid on the lower edge of the thumb.
.media-grid__meta {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  padding: 2px var(--space-1);
  font-size: var(--text-xs);
  line-height: 1.35;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-on-primary);
  background: linear-gradient(transparent, var(--color-scrim));
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
  pointer-events: none;
}
.media-grid__tile:hover .media-grid__meta,
.media-grid__tile:focus-visible .media-grid__meta { opacity: 1; }
.media-grid__name { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
