import type { DerivedImage } from './derive'
import { mergeTranslations, type Translations } from './translations'

export interface DerivativeEntry { key: string; width: number; height: number; mime: string }
export type DerivativeManifest = Record<string, DerivativeEntry>

export interface MediaInput {
  storageKey: string
  folder: string
  filename: string
  mime: string
  ext: string
  size: number
  checksum: string
  derived?: DerivedImage
  translations?: Record<string, { alt?: string; title?: string; description?: string }>
}

/**
 * Object key for a resized/reformatted variant of an original. The stem is the FULL original key
 * (extension included), so two same-stem uploads that differ only in extension — `logo.png` and
 * `logo.jpg`, a designer exporting both formats — never derive the same key and overwrite/cross-delete
 * each other's variants. `storageKey` is unique, so this stays injective per original.
 */
export function derivativeKey(originalKey: string, name: string, format: string): string {
  return `${originalKey}-${name}.${format}`
}

export function buildMediaValues(input: MediaInput): Record<string, unknown> {
  const manifest: DerivativeManifest = {}
  const src = input.derived
  for (const v of src?.variants ?? []) {
    // Name-keyed (`<name>.<format>`); height is the variant's REAL output dim (crops break the aspect ratio).
    manifest[`${v.name}.${v.format}`] = { key: derivativeKey(input.storageKey, v.name, v.format), width: v.width, height: v.height, mime: v.mime }
  }
  return {
    storageKey: input.storageKey,
    folder: input.folder || null,
    filename: input.filename,
    mime: input.mime,
    ext: input.ext,
    size: input.size,
    width: input.derived?.width ?? null,
    height: input.derived?.height ?? null,
    checksum: input.checksum,
    thumbhash: input.derived?.thumbhash ?? null,
    derivatives: manifest,
    translations: input.translations ?? {},
  }
}

/**
 * On overwrite (re-upload of an existing storageKey) the multipart request rarely re-sends
 * alt/title/description — the conflict-dialog overwrite path never does — so a bare re-upload must not
 * wipe the per-locale metadata editors maintain via the viewer. Merge any incoming fields over the
 * existing map (same semantics as the PATCH endpoint); an empty incoming map leaves the existing intact.
 */
export function withPreservedTranslations(
  values: Record<string, unknown>,
  existing: { translations?: Translations } | undefined,
): Record<string, unknown> {
  return { ...values, translations: mergeTranslations(existing?.translations, (values.translations ?? {}) as Translations) }
}
