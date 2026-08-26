import { createHash } from 'node:crypto'
import { eq, inArray, getTableColumns, isNull } from 'drizzle-orm'
import { createError, getRequestHeader, readMultipartFormData, setResponseStatus } from 'h3'
import { Effect } from 'effect'
import { Conflict, ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { DEFAULT_IMAGE_POLICY, assertBodyLimit, dbOf, definePipeline, eventOf, fromThrowingAsync, isUniqueViolation, mediaLockKey, primaryLocale, withLock } from '@michaelthielemann/kestrel-core'
import type { PipelineDef } from '@michaelthielemann/kestrel-core'
import { useMediaDbFor } from '../db/media-db.js'
import { useStorageDriver, mediaRuntimeConfig } from '../utils/storage.js'
import builtMedia, { media } from '../collections/media.js'
import { aiDisclosureEnabled } from '../utils/ai-disclosure-enabled.js'
import { detectAiSignal, aiSignalNote } from '../utils/ai-signal-detect.js'
import { deriveImage, RASTER, type DerivedImage } from '../utils/derive.js'
import { ensureFolder } from '../utils/folders.js'
import { requireMediaCollection } from '../utils/media-enabled.js'
import { emitMediaWrite, type EmitFacts } from '../utils/media-write.js'
import { sanitizeFolder, buildKey, suggestFreeName, withExtension } from '../utils/naming.js'
import { persistUpload } from '../utils/persist-upload.js'
import { buildMediaValues, derivativeKey, type DerivativeManifest } from '../utils/record.js'
import { sanitizeSvg } from '../utils/sanitize-svg.js'
import { sniffMime, extForMime, resolveAllowedMimes } from '../utils/sniff.js'
import type { Translations } from '../utils/translations.js'
import { activeVariants } from '../utils/variants.js'
import { MEDIA_WRITE_ACCESS } from './shared.js'

/** `rawBody: true` — the router leaves `input` undefined and this step consumes the multipart stream
 *  itself. The per-key `withLock` is what serialises concurrent uploads, so no step here is `sync`. */
export function buildMediaUploadPipeline(): PipelineDef {
  return definePipeline({
    name: 'upload',
    on: { collection: 'media' },
    access: MEDIA_WRITE_ACCESS,
    rawBody: true,
    steps: [{
      name: 'storeUpload',
      fn: (ctx) => Effect.gen(function* () {
        requireMediaCollection()
        const event = eventOf(ctx)
        const cfg = mediaRuntimeConfig()
        // Declared-length pre-check only; the real cap is re-asserted on the parsed bytes below.
        assertBodyLimit(getRequestHeader(event, 'content-length'), cfg.maxUploadBytes)

        const parts = yield* Effect.promise(() => readMultipartFormData(event))
        if (!parts) return yield* Effect.fail(new ValidationFailed({ issues: [{ path: [], message: 'Expected multipart/form-data' }] }))
        const filePart = parts.find((p) => p.name === 'file' && p.filename)
        if (!filePart || !filePart.data?.length) return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['file'], message: 'Missing file' }] }))
        if (filePart.data.length > cfg.maxUploadBytes) throw createError({ statusCode: 413, statusMessage: 'Payload too large' })
        const text = (n: string) => parts.find((p) => p.name === n && !p.filename)?.data.toString('utf8')

        let bytes = filePart.data as Buffer
        const allowed = resolveAllowedMimes(cfg.allowedMimes)
        const mime = yield* Effect.promise(() => sniffMime(bytes))
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

        const db = useMediaDbFor(dbOf(ctx)).db
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
          // A JS try/catch does NOT observe an Effect failure crossing a `yield*` — only Effect's own
          // combinators do — so the survivor rewrap has to be Effect.catchAll, not a wrapping try/catch.
          derived = yield* Effect.tryPromise({
            try: () => deriveImage(bytes, { ...policy, variants: activeVariants(db, policy.variants, policy.presets) }),
            catch: (error) => error,
          }).pipe(
            Effect.catchAll((error) => Effect.sync((): DerivedImage => {
              throw createError({ statusCode: 422, statusMessage: 'Could not process this image', data: { reason: (error as Error)?.message } })
            })),
          )
        }

        const alt = text('alt')
        const title = text('title')
        const description = text('description')
        const translations = alt || title || description ? { [primaryLocale()]: { alt, title, description } } : {}

        // EU AI Act Art. 50 disclosure. The classification is validated against the collection's own choice
        // schema so the allow-list has a single source of truth (same as `updateAsset`).
        const aiSourceType = text('aiSourceType')?.trim() || undefined
        if (aiSourceType && !builtMedia.update.safeParse({ aiSourceType }).success) {
          return yield* Effect.fail(new ValidationFailed({ issues: [{ path: ['aiSourceType'], message: `Invalid AI disclosure: unknown source type "${aiSourceType}"` }] }))
        }
        const uploadedAiNote = text('aiNote')?.trim() || undefined
        // Only parse when the feature is on: consumers who leave it off pay nothing for it. What the scan finds
        // is EVIDENCE for the free-text note — it never asserts `aiSourceType`, which stays a human decision.
        const signal = aiDisclosureEnabled() && !uploadedAiNote ? yield* Effect.promise(() => detectAiSignal(bytes, mime).catch(() => null)) : null

        // Serialize the collision-check → put → insert per storageKey: two concurrent uploads to the SAME key
        // (or a backfill re-deriving it) must not interleave, or last-writer-wins would leave the winning row
        // describing the loser's bytes. Different keys never share a lock, so throughput is unaffected.
        // withLock's own callback stays plain-async (its throws — Conflict, and a survivor 422 — are
        // reclassified below by fromThrowingAsync, which is what turns the specific Conflict back into a
        // proper Effect.fail while a bug/survivor stays a defect, unchanged either way).
        const { row, created } = yield* fromThrowingAsync(() => withLock(mediaLockKey(storageKey), async (): Promise<{ row: Record<string, unknown>; created: boolean }> => {
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
            throw new Conflict({
              field: 'storageKey',
              value: storageKey,
              details: { kind: 'duplicate', suggestion: suggestFreeName(filename, (n) => !takenNames.has(n)), existingId: existing?.id },
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
            const facts: EmitFacts = { occurredAt: ctx.facts.now, correlationId: ctx.facts.correlationId, causation: ctx.facts.causation }
            const saved = await persistUpload(db, driver, { storageKey, bytes, mime, derived, values, existing, overwrite, facts })
            return { row: saved, created: !(existing && overwrite) }
          } catch (error) {
            // A double-submit that slips through the check surfaces as a UNIQUE violation → 409, not a raw 500.
            if (isUniqueViolation(error)) {
              throw new Conflict({ field: 'storageKey', value: storageKey, details: { kind: 'duplicate' } })
            }
            throw error
          }
        }))

        // Only an overwrite can invalidate published output: it rewrites the bytes, dimensions, thumbhash and
        // derivative manifest under an unchanged id, so every page embedding it holds srcset candidates that no
        // longer exist. Gate on `created`, not the requested `overwrite` flag — an overwrite request that finds
        // no row inserts a fresh one, which nothing published can reference yet.
        if (!created) emitMediaWrite({ id: row.id as number }, row)

        setResponseStatus(event, created ? 201 : 200)
        ctx.output = { ...row, url: driver.publicUrl(storageKey) }
      }),
    }],
  })
}
