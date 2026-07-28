// The gallery's DECRYPTED working model + the pure transforms over it. The editor holds a `WorkingModel`
// in memory while unlocked; every folder/file mutation here is pure (no crypto, node-testable). Crossing
// the encryption boundary is isolated to `encodeIndex`/`decodeIndex`, which take an injected `seal`/`open`
// (so they unit-test with fakes and the crypto stays in `crypto.ts`). The encoded form is the
// `GalleryIndex` persisted at `galleries-secure/<galleryId>/index.json`.
import type { GalleryIndex, IndexFile, SealedB64 } from './manifest'
import { isUnder, joinFolder } from './path'

/** A decrypted file entry: stable `blobId`, the blob's `ivB64`, plaintext `name`/`mime`, and folder `dir`
 *  ('' = root). */
export interface WorkingFile {
  blobId: string
  ivB64: string
  name: string
  mime: string
  size: number
  dir: string
  alt?: string
}

/** The whole decrypted gallery: files + the explicit folder list (incl. empty folders). */
export interface WorkingModel {
  files: WorkingFile[]
  folders: string[]
}

export const emptyModel = (): WorkingModel => ({ files: [], folders: [] })

/** Seal a model into the persisted index. Re-seals every leaf (fresh IVs) — simple + correct; galleries
 *  are interactive-sized. The blob ciphertext is NOT touched (its `ivB64` is carried through). */
export async function encodeIndex(model: WorkingModel, seal: (s: string) => Promise<SealedB64>): Promise<GalleryIndex> {
  const files: IndexFile[] = []
  for (const f of model.files) {
    const file: IndexFile = { blobId: f.blobId, ivB64: f.ivB64, name: await seal(f.name), mime: f.mime, size: f.size }
    if (f.dir) file.dir = await seal(f.dir)
    if (f.alt) file.alt = await seal(f.alt)
    files.push(file)
  }
  const folders: SealedB64[] = []
  for (const p of model.folders) if (p) folders.push(await seal(p))
  return { v: 1, files, folders }
}

export async function decodeIndex(index: GalleryIndex, open: (s: SealedB64) => Promise<string>): Promise<WorkingModel> {
  const files: WorkingFile[] = []
  for (const f of index.files) {
    files.push({ blobId: f.blobId, ivB64: f.ivB64, name: await open(f.name), mime: f.mime, size: f.size ?? 0, dir: f.dir ? await open(f.dir) : '', alt: f.alt ? await open(f.alt) : undefined })
  }
  const folders: string[] = []
  for (const s of index.folders) folders.push(await open(s))
  return { files, folders }
}

// --- pure mutations (return a NEW model; never mutate the input) ---

export function addFile(m: WorkingModel, file: WorkingFile): WorkingModel {
  return { ...m, files: [...m.files, file] }
}

export function removeFile(m: WorkingModel, blobId: string): { model: WorkingModel; removed?: WorkingFile } {
  const removed = m.files.find((f) => f.blobId === blobId)
  return { model: { ...m, files: m.files.filter((f) => f.blobId !== blobId) }, removed }
}

/** Add an explicit folder (deduped). Empty path (root) is a no-op. */
export function addFolder(m: WorkingModel, path: string): WorkingModel {
  const p = joinFolder(path)
  if (!p || m.folders.includes(p)) return m
  return { ...m, folders: [...m.folders, p] }
}

/** Remove a folder and everything under it; returns the blobIds whose ciphertext must be deleted too. */
export function removeFolderRecursive(m: WorkingModel, path: string): { model: WorkingModel; removedBlobIds: string[] } {
  const p = joinFolder(path)
  if (!p) return { model: m, removedBlobIds: [] }
  const removedBlobIds = m.files.filter((f) => isUnder(f.dir, p)).map((f) => f.blobId)
  return {
    model: {
      files: m.files.filter((f) => !isUnder(f.dir, p)),
      folders: m.folders.filter((d) => !isUnder(d, p)),
    },
    removedBlobIds,
  }
}

/** Rename/move a folder subtree: rewrite the prefix of every file dir + folder entry under `from` to `to`. */
export function renameFolder(m: WorkingModel, from: string, to: string): WorkingModel {
  const f = joinFolder(from)
  const t = joinFolder(to)
  if (!f || f === t) return m
  if (isUnder(t, f)) return m // refuse to move a folder into its own descendant — would corrupt the subtree
  const rewrite = (d: string): string => (isUnder(d, f) ? joinFolder(t, d.slice(f.length)) : d)
  return {
    files: m.files.map((file) => ({ ...file, dir: rewrite(file.dir) })),
    folders: dedupe(m.folders.map(rewrite).filter(Boolean)),
  }
}

/** Move a single file into `dir` ('' = root). */
export function moveFile(m: WorkingModel, blobId: string, dir: string): WorkingModel {
  const d = joinFolder(dir)
  return { ...m, files: m.files.map((f) => (f.blobId === blobId ? { ...f, dir: d } : f)) }
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)]
