import { createError } from 'h3'
import { sanitizeFolder, buildKey, withExtension, extensionOf } from './naming.js'
import { childName, parentOf, rewritePrefix } from './folder-paths.js'
import type { OpItem, AffectedSet, AffectedMedia } from './media-ops.js'

/** One affected media row's source and planned destination key. */
export interface PlannedMedia {
  id: number
  fromKey: string
  toFolder: string
  toFilename: string
  toKey: string
}
/** One affected folder row's source and planned destination path. */
export interface PlannedFolder { from: string; to: string }
/** The full plan for one relocation item: its new root plus every affected row's target. */
export interface ItemPlan { toRoot: string; media: PlannedMedia[]; folders: PlannedFolder[] }

/** A rename must not introduce a path separator: take the last clean segment, never empty. */
function sanitizeSegment(name: string): string {
  const seg = childName(sanitizeFolder(name))
  if (!seg) throw createError({ statusCode: 400, statusMessage: 'Invalid name' })
  return seg
}

const planMedia = (m: AffectedMedia, toFolder: string): PlannedMedia => ({
  id: m.id, fromKey: m.storageKey, toFolder, toFilename: m.filename, toKey: buildKey(toFolder, m.filename),
})

/** Re-base every affected media row + folder path from the `from` subtree onto `to`. */
function cascade(affected: AffectedSet, from: string, to: string): Pick<ItemPlan, 'media' | 'folders'> {
  return {
    media: affected.media.map((m) => planMedia(m, rewritePrefix(m.folder ?? '', from, to))),
    folders: affected.folders.map((fp) => ({ from: fp, to: rewritePrefix(fp, from, to) })),
  }
}

/** Targets for moving/copying an item into `dest` (file → dest unchanged; folder → dest/<name>). */
export function planRelocateInto(item: OpItem, affected: AffectedSet, dest: string): ItemPlan {
  const to = sanitizeFolder(dest)
  if (item.type === 'file') {
    const m = affected.media[0]
    if (!m) throw createError({ statusCode: 404, statusMessage: 'Media not found' })
    return { toRoot: to, media: [planMedia(m, to)], folders: [] }
  }
  const toRoot = to === '' ? childName(item.path) : `${to}/${childName(item.path)}`
  return { toRoot, ...cascade(affected, item.path, toRoot) }
}

/** Targets for renaming an item in place (file → new filename; folder → new last segment). */
export function planRename(item: OpItem, affected: AffectedSet, name: string): ItemPlan {
  if (item.type === 'file') {
    const m = affected.media[0]
    if (!m) throw createError({ statusCode: 404, statusMessage: 'Media not found' })
    const toFolder = m.folder ?? ''
    const toFilename = withExtension(name, extensionOf(m.filename))
    return {
      toRoot: toFolder, folders: [],
      media: [{ id: m.id, fromKey: m.storageKey, toFolder, toFilename, toKey: buildKey(toFolder, toFilename) }],
    }
  }
  const parent = parentOf(item.path) ?? ''
  const seg = sanitizeSegment(name)
  const toRoot = parent === '' ? seg : `${parent}/${seg}`
  return { toRoot, ...cascade(affected, item.path, toRoot) }
}
