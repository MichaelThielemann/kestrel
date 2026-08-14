import { createHash } from 'node:crypto'
import { eq, inArray, getTableColumns, isNull } from 'drizzle-orm'
import builtMedia, { media } from '../../collections/media'
import { useStorageDriver, mediaRuntimeConfig } from '../../../../core/server/utils/storage'
import { sniffMime, extForMime, resolveAllowedMimes } from '../../utils/sniff'
import { sanitizeFolder, buildKey, suggestFreeName, withExtension } from '../../utils/naming'
import { sanitizeSvg } from '../../utils/sanitize-svg'
import { deriveImage, RASTER, type DerivedImage } from '../../utils/derive'
import { DEFAULT_IMAGE_POLICY } from '../../../../core/server/utils/kestrel-config'
import { buildMediaValues, derivativeKey, type DerivativeManifest } from '../../utils/record'
import { persistUpload } from '../../utils/persist-upload'
import type { Translations } from '../../utils/translations'
import { activeVariants } from '../../utils/variants'
import { ensureFolder } from '../../utils/folders'
import { primaryLocale } from '../../../../core/server/utils/locale'
import { isUniqueViolation } from '../../../../core/server/utils/crud'
import { withLock, mediaLockKey } from '../../../../core/server/utils/key-lock'
import { requireMediaCollection } from '../../utils/media-enabled'
import { emitMediaWrite } from '../../utils/media-write'
import { detectAiSignal, aiSignalNote } from '../../utils/ai-signal-detect'
import { aiDisclosureEnabled } from '../../utils/ai-disclosure-enabled'

export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  requireMediaCollection()
  const cfg = mediaRuntimeConfig()
  const len = Number(getRequestHeader(event, 'content-length'))
  // A missing/garbage Content-Length means a chunked transfer, which readMultipartFormData would
  // buffer with no ceiling — refuse it up front. The declared length is then a cheap pre-check; the
  // real cap is re-asserted on the parsed bytes below (a client can under-declare Content-Length).
  if (!Number.isFinite(len) || len < 0) {
    throw createError({ statusCode: 411, statusMessage: 'Length required' })
  }
  if (len > cfg.maxUploadBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
  }

  const parts = await readMultipartFormData(event)
  if (!parts) throw createError({ statusCode: 400, statusMessage: 'Expected multipart/form-data' })
  const filePart = parts.find((p) => p.name === 'file' && p.filename)
  if (!filePart || !filePart.data?.length) throw createError({ statusCode: 400, statusMessage: 'Missing file' })
  if (filePart.data.length > cfg.maxUploadBytes) throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
  const text = (n: string) => parts.find((p) => p.name === n && !p.filename)?.data.toString('utf8')

  let bytes = filePart.data as Buffer
  const allowed = resolveAllowedMimes(cfg.allowedMimes)
  const mime = await sniffMime(bytes)
  if (!mime || !allowed.has(mime)) {
    throw createError({ statusCode: 415, statusMessage: `Unsupported media type${mime ? `: ${mime}` : ''}` })
  }
  const ext = extForMime(mime)

  if (mime === 'image/svg+xml') bytes = Buffer.from(sanitizeSvg(bytes.toString('utf8')))

  // server-controlled key only (folder + filename are both sanitized → no path traversal)
  const folder = sanitizeFolder(text('folder') ?? '')
  const overwrite = text('overwrite') === 'true'
  // The stored extension follows the sniffed type, never the client filename (content-type confusion).
  const filename = withExtension(text('filename') ?? filePart.filename ?? 'file', ext)
  const storageKey = buildKey(folder, filename)

  const db = useDb()
  const cols = getTableColumns(media) as Record<string, never>
  const driver = useStorageDriver()

  const checksum = createHash('sha256').update(bytes).digest('hex')
  // Narrow generation: derive exactly the currently-registered variant set (the media_settings registry),
  // falling back to the config policy's variants when the registry is empty (fresh project / no scan yet).
  // Done BEFORE the per-key lock so uploads of different files derive in parallel (sharp is the hot path).
  const policy = cfg.imagePolicy ?? DEFAULT_IMAGE_POLICY
  // A raster that sniffs fine but is truncated/corrupt (or a misconfigured crop position slipping past
  // validation) makes sharp reject mid-pipeline — a bare unwrapped throw here would 500 with an internal
  // vips error string. Surface it as a real, unprocessable-upload 4xx instead.
  let derived: DerivedImage | undefined
  if (RASTER.has(mime)) {
    try {
      derived = await deriveImage(bytes, { ...policy, variants: activeVariants(db, policy.variants, policy.presets) })
    } catch (error) {
      throw createError({ statusCode: 422, statusMessage: 'Could not process this image', data: { reason: (error as Error)?.message } })
    }
  }

  const alt = text('alt')
  const title = text('title')
  const description = text('description')
  const translations = alt || title || description ? { [primaryLocale()]: { alt, title, description } } : {}

  // EU AI Act Art. 50 disclosure. The classification is validated against the collection's own choice
  // schema so the allow-list has a single source of truth (same as the PATCH route).
  const aiSourceType = text('aiSourceType')?.trim() || undefined
  if (aiSourceType && !builtMedia.update.safeParse({ aiSourceType }).success) {
    throw createError({ statusCode: 400, statusMessage: `Invalid AI disclosure: unknown source type "${aiSourceType}"` })
  }
  const uploadedAiNote = text('aiNote')?.trim() || undefined
  // Only parse when the feature is on: consumers who leave it off pay nothing for it. What the scan finds
  // is EVIDENCE for the free-text note — it never asserts `aiSourceType`, which stays a human decision.
  const signal = aiDisclosureEnabled() && !uploadedAiNote ? await detectAiSignal(bytes, mime).catch(() => null) : null

  // Serialize the collision-check → put → insert per storageKey: two concurrent uploads to the SAME key
  // (or a backfill re-deriving it) must not interleave, or last-writer-wins would leave the winning row
  // describing the loser's bytes. Different keys never share a lock, so throughput is unaffected.
  const { row, created } = await withLock(mediaLockKey(storageKey), async (): Promise<{ row: Record<string, unknown>; created: boolean }> => {
    const existing = db.select().from(media).where(eq(cols.storageKey, storageKey)).get() as
      | { id: number; derivatives?: DerivativeManifest; translations?: Translations; aiNote?: string | null }
      | undefined

    // An object on disk with no media row (another media's derivative, or an orphan) must never be
    // clobbered — not even under overwrite, which only replaces a managed media row.
    const blockedByDisk = !existing && (await driver.exists?.(storageKey))
    if ((existing && !overwrite) || blockedByDisk) {
      // One query: the filenames already taken in this folder, used to suggest a free name in memory.
      const takenNames = new Set(
        db.select({ f: cols.filename }).from(media)
          .where(folder ? eq(cols.folder, folder) : isNull(cols.folder))
          .all().map((r) => (r as { f: string }).f),
      )
      if (blockedByDisk) takenNames.add(filename)
      throw createError({
        statusCode: 409,
        statusMessage: 'A file with this name already exists',
        data: { storageKey, existingId: existing?.id, suggestion: suggestFreeName(filename, (n) => !takenNames.has(n)) },
      })
    }

    // Reserve the derivative namespace: `derivativeKey` mints a syntactically valid ORIGINAL key
    // (`<key>-<name>.<format>`), so a same-named upload elsewhere (or a coincidentally matching filename)
    // can already own the exact key this derive is about to `driver.put` over. The create-path write below
    // has no per-key collision check of its own, so refuse up front rather than silently overwrite another
    // row's blob out from under it.
    const derivKeys = (derived?.variants ?? []).map((v) => derivativeKey(storageKey, v.name, v.format))
    if (derivKeys.length) {
      const clash = db.select({ storageKey: cols.storageKey }).from(media).where(inArray(cols.storageKey, derivKeys)).all() as { storageKey: string }[]
      if (clash.length) {
        // Not a 409: the uploader reads that status as the rename/overwrite/skip name-conflict contract,
        // and neither branch resolves this — the requested name is free, and overwriting it re-derives the
        // very same blocked keys. The message names the file the user actually dropped, plus the existing
        // one standing in its way, so the remedy (rename either) is visible from the upload dialog.
        throw createError({
          statusCode: 422,
          statusMessage: `Cannot store "${filename}": the existing file "${clash[0]!.storageKey}" already uses a name reserved for one of its generated image sizes. Rename either file, then upload again.`,
          data: { storageKey, clashKeys: clash.map((c) => c.storageKey) },
        })
      }
    }

    if (folder) ensureFolder(db, folder)
    // The scan only ever fills a note that would otherwise be empty — it must not talk over an uploader's
    // own text, nor over one an editor already curated on the row this upload is replacing.
    const aiNote = uploadedAiNote ?? (existing?.aiNote ? undefined : signal && aiSignalNote(signal))
    const values = buildMediaValues({ storageKey, folder, filename, mime, ext, size: bytes.length, checksum, derived, translations, aiSourceType, aiNote })
    try {
      // persistUpload writes the objects then the row; on a create-path failure it removes the freshly-written
      // blobs so a partial upload never strands orphans that permanently 409-block the filename.
      const saved = await persistUpload(db, driver, { storageKey, bytes, mime, derived, values, existing, overwrite })
      return { row: saved, created: !(existing && overwrite) }
    } catch (error) {
      // A double-submit that slips through the check surfaces as a UNIQUE violation → 409, not a raw 500.
      if (isUniqueViolation(error)) {
        throw createError({ statusCode: 409, statusMessage: 'A file with this name already exists', data: { storageKey } })
      }
      throw error
    }
  })

  // Only an overwrite can invalidate published output: it rewrites the bytes, dimensions, thumbhash and
  // derivative manifest under an unchanged id, so every page embedding it holds srcset candidates that no
  // longer exist. Gate on `created`, not the requested `overwrite` flag — an overwrite request that finds
  // no row inserts a fresh one, which nothing published can reference yet.
  if (!created) emitMediaWrite({ id: row.id as number }, row)

  setResponseStatus(event, created ? 201 : 200)
  return { ...row, url: driver.publicUrl(storageKey) }
})
