// Adapts the gallery's DECRYPTED working model to the media layer's `LibraryItem[]` so the editor can drive
// `MediaGrid`/`MediaTable` (the same explorer chrome as the media picker) over encrypted gallery content.
// Pure + node-testable. The `LibraryItem`/`LibraryFile`/`LibraryFolder` shapes are redeclared locally
// (structurally matching the media layer) so the extension does not path-import across packages; the extra
// `blobId` on a file lets the widget map a clicked item back to its blob for ops (MediaGrid ignores it).
import type { WorkingFile } from './index-codec'
import { childFolders, isUnder, segments } from './path'

export interface LibraryFolder { path: string; name: string; size: number }
export interface LibraryFile {
  id: number; filename: string; mime: string; folder: string; size: number
  width?: number; height?: number; thumbhash?: string; src: string; srcset?: string; alt?: string
  // `blobId` is OPTIONAL only so this structurally matches the media layer's `LibraryFile` (which has no
  // such field) — keeping `LibraryItem` mutually assignable with media's for the MediaGrid/Table contract.
  // The adapter ALWAYS populates it; the widget reads it for per-file ops.
  blobId?: string
}
export type LibraryItem =
  | { type: 'folder'; folder: LibraryFolder }
  | { type: 'file'; file: LibraryFile }

/** A stable positive int id for a blobId (FNV-1a/31-bit) — MediaGrid/Table key + select by `file:${id}`. */
export function fileId(blobId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < blobId.length; i++) { h ^= blobId.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 1) // drop the sign bit → non-negative
}

/** Build the `LibraryItem[]` for `currentFolder`: immediate child folders (with recursive file counts) then
 *  the files directly in this folder. `previews[blobId]` supplies the decrypted object-URL `src`. */
export function toLibraryItems(
  currentFolder: string,
  files: WorkingFile[],
  folders: string[],
  previews: Record<string, { src: string } | undefined>,
): LibraryItem[] {
  const fileDirs = files.map((f) => f.dir)
  const folderItems: LibraryItem[] = childFolders(currentFolder, folders, fileDirs).map((path) => ({
    type: 'folder',
    folder: { path, name: segments(path).at(-1) ?? path, size: files.filter((f) => isUnder(f.dir, path)).length },
  }))
  const fileItems: LibraryItem[] = files
    .filter((f) => f.dir === currentFolder)
    .map((f) => ({
      type: 'file',
      file: {
        id: fileId(f.blobId), filename: f.name, mime: f.mime, folder: currentFolder, size: f.size,
        src: previews[f.blobId]?.src ?? '', blobId: f.blobId, alt: f.alt,
      },
    }))
  return [...folderItems, ...fileItems]
}
