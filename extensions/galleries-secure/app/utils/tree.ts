// Build a folder/file tree from the DECRYPTED gallery items. Pure + framework-free (no Vue, no DOM, no
// crypto) so it unit-tests under Node — the load-bearing structure logic lives here; the composable is just
// a thin reactive shell that decrypts then calls this. Folder paths come from each item's decrypted `dir`
// (e.g. "2024/Trauung"); an empty/absent dir means the gallery root.

/** One decrypted image ready to render: an object-URL `src` (or a `failed` marker), the original name, mime. */
export interface GalleryImage {
  name: string
  src: string
  mime: string
  blobKey: string
  failed?: boolean
}

/** Input to {@link buildTree}: a decrypted image plus the (decrypted) folder path it belongs to. */
export interface DecryptedItem extends GalleryImage {
  dir: string
}

/** A node in the rendered tree: either a folder (with children) or an image leaf. */
export type GalleryNode =
  | { type: 'folder'; name: string; path: string; children: GalleryNode[] }
  | ({ type: 'image' } & GalleryImage)

interface FolderBuild {
  name: string
  path: string
  folders: Map<string, FolderBuild>
  images: GalleryImage[]
}

const newFolder = (name: string, path: string): FolderBuild => ({ name, path, folders: new Map(), images: [] })

/** Split a dir into clean segments ("/a//b/" → ["a","b"]); empty → [] (root). */
const segments = (dir: string): string[] => dir.split('/').map((s) => s.trim()).filter(Boolean)

function finalize(folder: FolderBuild): GalleryNode[] {
  const folders = [...folder.folders.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<GalleryNode>((f) => ({ type: 'folder', name: f.name, path: f.path, children: finalize(f) }))
  const images = [...folder.images]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<GalleryNode>((img) => ({ type: 'image', ...img }))
  // Folders first, then images — the conventional file-browser ordering.
  return [...folders, ...images]
}

/** Walk/create the folder chain for a dir, returning the leaf FolderBuild. */
function ensurePath(root: FolderBuild, dir: string): FolderBuild {
  let here = root
  for (const seg of segments(dir)) {
    let next = here.folders.get(seg)
    if (!next) {
      next = newFolder(seg, here.path ? `${here.path}/${seg}` : seg)
      here.folders.set(seg, next)
    }
    here = next
  }
  return here
}

/**
 * Build the nested folder/image tree. Items with the same dir land in the same folder; nested dirs create
 * nested folders (merged by name). `folders` seeds EMPTY folders (paths with no files) so they still
 * appear. Folders sort before images, both alphabetically — deterministic output.
 */
export function buildTree(items: DecryptedItem[], folders: string[] = []): GalleryNode[] {
  const root = newFolder('', '')
  for (const dir of folders) ensurePath(root, dir)
  for (const item of items) {
    const here = ensurePath(root, item.dir)
    const { dir: _dir, ...image } = item
    here.images.push(image)
  }
  return finalize(root)
}
