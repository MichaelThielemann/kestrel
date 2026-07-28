// Drag-&-drop file intake — adapted (copied) from Kestrel's media layer, kept SELF-CONTAINED so the secure
// gallery doesn't depend on the media layer (which may be disabled). Zero-knowledge-agnostic: it only
// collects dropped files + their folder paths (whole folders included). The widget then encrypts each file
// and uploads ciphertext, using the folder path as the sealed `dir`. Pure + isomorphic → node-tested.

export interface PendingUpload { file: File; folder: string }
export interface WalkResult { uploads: PendingUpload[]; dirs: string[] }

export interface DirectoryReaderLike {
  readEntries(success: (entries: EntryLike[]) => void, error?: (e: unknown) => void): void
}
export interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?(success: (file: File) => void, error?: (e: unknown) => void): void
  createReader?(): DirectoryReaderLike
}

const joinFolder = (base: string, name: string): string => (base ? `${base}/${name}` : name)

/** Drain a DirectoryReader — readEntries yields in batches (Chrome caps ~100), loop until empty. */
export function readAllEntries(reader: DirectoryReaderLike): Promise<EntryLike[]> {
  return new Promise((resolve, reject) => {
    const all: EntryLike[] = []
    const next = () => reader.readEntries((batch) => { if (!batch.length) return resolve(all); all.push(...batch); next() }, reject)
    next()
  })
}

function entryFile(entry: EntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file!((f) => resolve(f), reject))
}

export async function walkEntry(entry: EntryLike, base: string, out: WalkResult): Promise<void> {
  if (entry.isFile) {
    out.uploads.push({ file: await entryFile(entry), folder: base })
  } else if (entry.isDirectory && entry.createReader) {
    const dir = joinFolder(base, entry.name)
    out.dirs.push(dir)
    for (const child of await readAllEntries(entry.createReader())) await walkEntry(child, dir, out)
  }
}

interface DataTransferLike {
  items?: ArrayLike<{ webkitGetAsEntry?(): EntryLike | null }> | null
  files?: ArrayLike<File> | null
}

/** Collect dropped files (and whole folders, via the webkit entry API) under `base`. Grabs the entry list
 *  SYNCHRONOUSLY first — the DataTransferItemList dies once the drop handler yields to an await. */
export async function extractUploads(dt: DataTransferLike, base: string): Promise<WalkResult> {
  const out: WalkResult = { uploads: [], dirs: [] }
  const entries = (dt.items ? Array.from(dt.items) : [])
    .map((it) => it.webkitGetAsEntry?.() ?? null)
    .filter((e): e is EntryLike => !!e)
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, base, out)
  } else {
    for (const file of Array.from(dt.files ?? [])) out.uploads.push({ file, folder: base })
  }
  return out
}
