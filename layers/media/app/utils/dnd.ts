import { joinFolder } from './library'

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

export async function extractUploads(dt: DataTransferLike, base: string): Promise<WalkResult> {
  const out: WalkResult = { uploads: [], dirs: [] }
  // Grab entries SYNCHRONOUSLY before any await — the DataTransferItemList dies once the handler yields.
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

/** The minimal set of folders to create explicitly: dirs no uploaded file already creates
 *  (ensure-on-upload makes a file's whole ancestor chain), reduced to the deepest. */
export function selectEmptyFolders(uploads: PendingUpload[], dirs: string[]): string[] {
  const covered = new Set<string>()
  for (const u of uploads) {
    const segs = u.folder.split('/').filter(Boolean)
    for (let i = 1; i <= segs.length; i++) covered.add(segs.slice(0, i).join('/'))
  }
  const empty = dirs.filter((d) => d && !covered.has(d))
  return empty.filter((d) => !empty.some((o) => o !== d && o.startsWith(`${d}/`)))
}
