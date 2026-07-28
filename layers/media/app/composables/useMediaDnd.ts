import { ref } from 'vue'
import { extractUploads, selectEmptyFolders, type PendingUpload } from '../utils/dnd'
import type { OpItem } from '../utils/ops'

const MEDIA_DRAG = 'application/x-kestrel-media'
export interface DropResult { uploads: PendingUpload[]; folders: string[] }

function hoveredFolder(e: DragEvent): string | null {
  const el = (e.target as HTMLElement | null)?.closest?.('[data-drop-folder]') as HTMLElement | null
  return el ? el.getAttribute('data-drop-folder') : null
}
function dragTypes(e: DragEvent): string[] { return e.dataTransfer ? Array.from(e.dataTransfer.types) : [] }
function isInternal(e: DragEvent): boolean { return dragTypes(e).includes(MEDIA_DRAG) }
function isFiles(e: DragEvent): boolean { return dragTypes(e).includes('Files') }

export function useMediaDnd(opts: {
  currentFolder: () => string
  onDrop: (r: DropResult) => void
  draggedItems: () => OpItem[]
  onMove: (items: OpItem[], dest: string) => void
}) {
  const dragActive = ref(false)
  const dropFolder = ref<string | null>(null)
  let depth = 0

  // Only a genuine OS file-drag raises the upload overlay. An internal item-drag may also carry 'Files'
  // in dataTransfer.types on some platforms, so the internal marker takes precedence.
  function onDragEnter(e: DragEvent) { e.preventDefault(); depth++; if (isFiles(e) && !isInternal(e)) dragActive.value = true }
  function onDragOver(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = isInternal(e) ? 'move' : 'copy'
    dropFolder.value = hoveredFolder(e)
  }
  function onDragLeave(_e: DragEvent) {
    depth = Math.max(0, depth - 1)
    if (depth === 0) { dragActive.value = false; dropFolder.value = null }
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault()
    depth = 0
    dragActive.value = false
    const dest = hoveredFolder(e)
    dropFolder.value = null
    if (!e.dataTransfer) return
    if (isInternal(e)) {
      const its = opts.draggedItems()
      if (dest !== null && its.length && !its.some((i) => i.type === 'folder' && i.path === dest)) opts.onMove(its, dest)
      return
    }
    const base = dest ?? opts.currentFolder()
    const { uploads, dirs } = await extractUploads(e.dataTransfer, base)
    opts.onDrop({ uploads, folders: selectEmptyFolders(uploads, dirs) })
  }

  return { dragActive, dropFolder, onDragEnter, onDragOver, onDragLeave, onDrop }
}
