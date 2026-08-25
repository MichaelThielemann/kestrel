import { fileTypeFromBuffer } from 'file-type'

/** Default upload allow-list — sniffable, safe formats. NO executable/active types (html/js/swf →
 *  XSS from the media origin) and no plain-text (txt/csv: no magic bytes → unsniffable). Override
 *  the whole set via KESTREL_MEDIA_ALLOWED_MIME (see resolveAllowedMimes). Exact file-type\@22 MIMEs. */
export const DEFAULT_ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'video/mp4', 'video/webm', 'video/quicktime',
  // audio (file-type emits 'audio/x-m4a' for typical m4a, 'audio/ogg; codecs=opus' for opus)
  'audio/mpeg', 'audio/ogg', 'audio/ogg; codecs=opus', 'audio/wav', 'audio/flac', 'audio/x-m4a', 'audio/mp4',
])

/** Resolve the effective allow-list: a non-empty comma list overrides the default entirely. */
export function resolveAllowedMimes(configured: string | undefined): Set<string> {
  const list = (configured ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? new Set(list) : DEFAULT_ALLOWED_MIME
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'application/pdf': 'pdf', 'image/svg+xml': 'svg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'opus',
  'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/x-m4a': 'm4a', 'audio/mp4': 'm4a',
}

function looksLikeSvg(bytes: Buffer): boolean {
  let head = bytes.subarray(0, 1024).toString('utf8').trimStart()
  // Skip any leading XML declaration, DOCTYPE, and comments (some exporters emit these before <svg>),
  // then require the root element to be <svg>.
  for (let prev = ''; head !== prev; ) {
    prev = head
    head = head
      .replace(/^<\?xml\b[^>]*\?>\s*/i, '')
      .replace(/^<!DOCTYPE\b[^>]*>\s*/i, '')
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .trimStart()
  }
  return /^<svg[\s>]/i.test(head)
}

/** Detect the real MIME from the bytes (magic-byte sniff, then an SVG text heuristic). Pure
 *  detection — authorization against the allow-list is the caller's job. */
export async function sniffMime(bytes: Buffer): Promise<string | null> {
  const ft = await fileTypeFromBuffer(bytes)
  // An SVG that opens with an XML declaration / DOCTYPE is reported by the magic-byte sniff as generic XML;
  // promote it to image/svg+xml when the root element is actually <svg>. A non-XML detection is trusted as-is.
  if (ft && ft.mime !== 'application/xml' && ft.mime !== 'text/xml') return ft.mime
  if (looksLikeSvg(bytes)) return 'image/svg+xml'
  return ft ? ft.mime : null
}

/** File extension for a MIME type, `bin` when unknown. */
export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin'
}
