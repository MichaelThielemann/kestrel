/**
 * Upload-time scan for signals that a file was AI-generated or -manipulated (EU AI Act Art. 50).
 *
 * **This produces EVIDENCE, never a classification.** Everything it finds is quoted into the free-text
 * `aiNote`; the legal `aiSourceType` stays a deliberate human decision, because a signal is neither proof
 * nor its absence a disproof: metadata survives no re-save, screenshot or re-encode, and an upstream file
 * can be mislabeled or forged. In particular a C2PA manifest is reported as PRESENT only — verifying its
 * signature needs the full C2PA SDK plus a trust list, which Kestrel deliberately does not ship.
 *
 * Pure (no DB, no Nitro) so it stays unit-testable, and never throws: an unreadable file is simply no
 * evidence, which must not fail the upload it came with.
 */

/** Tools that name themselves in EXIF `Software`. Matched case-insensitively as whole phrases, so an
 *  ordinary "Adobe Photoshop" is not caught by the "Adobe Firefly" entry. */
const KNOWN_GENERATORS = [
  'midjourney', 'dall-e', 'dall·e', 'adobe firefly', 'stable diffusion', 'leonardo.ai',
  'nightcafe', 'bing image creator', 'google imagefx', 'imagen', 'flux.1', 'ideogram',
]

/** PNG text-chunk keywords the Stable-Diffusion / ComfyUI families write their generation graph under. */
const GENERATION_KEYWORDS = ['parameters', 'prompt', 'workflow']

/** The result of an AI-origin evidence scan on an uploaded file.
 * @public
 */
export interface AiSignal {
  /** One human-readable line per signal found, in a stable order. Never empty (the result is null instead). */
  evidence: string[]
}

/** Walk PNG chunks after the 8-byte signature, yielding `[type, data]`. Bails out on any malformed length. */
function* pngChunks(bytes: Buffer): Generator<[string, Buffer]> {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504E47) return
  let at = 8
  while (at + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(at)
    const end = at + 8 + len
    if (len > bytes.length || end + 4 > bytes.length) return
    yield [bytes.toString('latin1', at + 4, at + 8), bytes.subarray(at + 8, end)]
    at = end + 4 // skip the trailing CRC
  }
}

/** Walk JPEG marker segments after SOI, yielding `[marker, payload]`. Stops at SOS (entropy-coded data). */
function* jpegSegments(bytes: Buffer): Generator<[number, Buffer]> {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xFF) return
    const marker = bytes[at + 1]!
    if (marker === 0xDA || marker === 0xD9) return
    const len = bytes.readUInt16BE(at + 2)
    if (len < 2 || at + 2 + len > bytes.length) return
    yield [marker, bytes.subarray(at + 4, at + 2 + len)]
    at += 2 + len
  }
}

/** Walk RIFF/WebP chunks, yielding `[fourcc, data]`. Chunks are padded to an even length. */
function* riffChunks(bytes: Buffer): Generator<[string, Buffer]> {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF') return
  let at = 12
  while (at + 8 <= bytes.length) {
    const len = bytes.readUInt32LE(at + 4)
    const end = at + 8 + len
    if (len > bytes.length || end > bytes.length) return
    yield [bytes.toString('latin1', at, at + 4), bytes.subarray(at + 8, end)]
    at = end + (len % 2)
  }
}

/**
 * The IPTC Digital Source Type a generator self-declared, read straight out of the embedded XMP packet.
 * Deliberately a byte-level scan rather than a metadata library: XMP is the same XML in every container,
 * so this also covers the ones exifr cannot open (WebP), and it costs one `indexOf` when absent.
 */
function findDigitalSourceType(bytes: Buffer): string | null {
  const at = bytes.indexOf('DigitalSourceType', 0, 'latin1')
  if (at < 0) return null
  const window = bytes.toString('latin1', at, Math.min(at + 512, bytes.length))
  // Both XMP serializations: as an rdf:Description attribute, or as its own element.
  const value = /^DigitalSourceType\s*=\s*"([^"]*)"/.exec(window)?.[1]
    ?? /^DigitalSourceType[^>]*>([^<]*)</.exec(window)?.[1]
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** True when the file structurally carries a C2PA/JUMBF manifest store. Presence only — never verified. */
function hasC2paManifest(bytes: Buffer): boolean {
  for (const [type] of pngChunks(bytes)) if (type === 'caBX') return true
  // C2PA-in-JPEG lives in APP11 segments whose payload starts with the JUMBF "JP" identifier.
  for (const [marker, payload] of jpegSegments(bytes)) {
    if (marker === 0xEB && payload.length >= 2 && payload.toString('latin1', 0, 2) === 'JP') return true
  }
  for (const [fourcc] of riffChunks(bytes)) if (fourcc === 'C2PA') return true
  return false
}

/** The generation-parameter keyword a PNG text chunk is stored under, or null. Covers tEXt/zTXt/iTXt —
 *  in all three the keyword is the leading null-terminated string, so a compressed payload needs no
 *  inflating to be recognised (exifr only decodes the uncompressed tEXt form). */
function findPngGenerationChunk(bytes: Buffer): string | null {
  for (const [type, data] of pngChunks(bytes)) {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue
    const nul = data.indexOf(0)
    const keyword = data.toString('latin1', 0, nul < 0 ? data.length : nul).toLowerCase()
    if (GENERATION_KEYWORDS.includes(keyword)) return keyword
  }
  return null
}

/** The EXIF `Software`/`ProcessingSoftware` value, when it names a tool on the known-generator list. */
async function findGeneratorSoftware(bytes: Buffer): Promise<string | null> {
  let tags: Record<string, unknown> | undefined
  try {
    // Loaded lazily: consumers who never turn the feature on never pay the module's parse cost.
    const exifr = (await import('exifr')).default
    tags = await exifr.parse(bytes, { tiff: true, exif: true, mergeOutput: true }) as Record<string, unknown> | undefined
  } catch {
    return null // an unsupported container or a corrupt header is simply no evidence
  }
  for (const key of ['Software', 'ProcessingSoftware']) {
    const value = tags?.[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const haystack = value.toLowerCase()
    if (KNOWN_GENERATORS.some((g) => haystack.includes(g))) return value.trim()
  }
  return null
}

/**
 * Scan an uploaded file for AI-origin signals. Returns null when nothing matched — which is NOT evidence
 * of non-AI origin, only the absence of a declaration.
 */
export async function detectAiSignal(bytes: Buffer, _mime: string): Promise<AiSignal | null> {
  const evidence: string[] = []

  const sourceType = findDigitalSourceType(bytes)
  if (sourceType) evidence.push(`IPTC/XMP Digital Source Type: ${sourceType}`)

  const software = await findGeneratorSoftware(bytes)
  if (software) evidence.push(`EXIF Software: ${software}`)

  if (hasC2paManifest(bytes)) {
    evidence.push('C2PA content-credentials manifest present (unverified — presence only, no signature check)')
  }

  const keyword = findPngGenerationChunk(bytes)
  if (keyword) evidence.push(`PNG text chunk "${keyword}" present (Stable-Diffusion-style generation parameters)`)

  return evidence.length ? { evidence } : null
}

/** How the scan's findings are worded into `aiNote`. Kept here so the wording has one home. */
export function aiSignalNote(signal: AiSignal): string {
  return `Detected at upload: ${signal.evidence.join('; ')}`
}
