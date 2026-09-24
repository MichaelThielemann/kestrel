/**
 * The extension of every media type a published file may be served as: types a browser shows or offers
 * as a download from a static host, never one it opens as a document that runs script (no HTML, XHTML,
 * XML or JavaScript). `image/svg+xml` is listed, but {@link publicFormOf} publishes an SVG as one only
 * when its bytes passed `sanitize.svg`.
 */
export const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "application/rtf": "rtf",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "7z",
  "application/vnd.rar": "rar",
  "application/x-rar-compressed": "rar",
  "application/x-tar": "tar",
};

/** The content type a file is published with when it is not published as its own type; every host offers it as a download. */
export const NEUTRAL_TYPE = "application/octet-stream";

/** The extension a file published as {@link NEUTRAL_TYPE} carries. */
export const NEUTRAL_EXTENSION = "bin";

const SVG = "image/svg+xml";
const TOKEN = "[-!#$%&'*+.^_`|~0-9A-Za-z]+";
const QUOTED = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t \\x21-\\x7e])*"';
const ESSENCE = new RegExp(`[\\t ]*(${TOKEN})/(${TOKEN})`, "y");
const PARAMETER = new RegExp(`[\\t ]*;[\\t ]*(?:${TOKEN}=(?:${TOKEN}|${QUOTED}))?`, "y");
const TRAILING = /[\t ]*$/y;

/**
 * The essence `type/subtype`, lower-cased, of a declared content type that is exactly one media type as
 * RFC 9110 defines it: a type and a subtype of token characters, optionally followed by `;` parameters,
 * with no comma anywhere. `null` for anything else — an empty string, a list of types, a stray
 * character — since a browser reading a list uses the last type in it.
 */
export function mediaTypeEssence(declared: string): string | null {
  if (declared.includes(",")) return null;
  ESSENCE.lastIndex = 0;
  const essence = ESSENCE.exec(declared);
  if (essence === null) return null;
  let at = ESSENCE.lastIndex;
  for (;;) {
    PARAMETER.lastIndex = at;
    if (PARAMETER.exec(declared) === null) break;
    at = PARAMETER.lastIndex;
  }
  TRAILING.lastIndex = at;
  return TRAILING.test(declared) ? `${essence[1]}/${essence[2]}`.toLowerCase() : null;
}

/**
 * How a stored file is published wherever a host serves it without an access check (a public copy, a
 * variant path, its public URL): the essence of its content type and that type's extension from
 * {@link EXTENSION_BY_TYPE}, or {@link NEUTRAL_TYPE} and {@link NEUTRAL_EXTENSION} when the type is not
 * listed, is not exactly one media type, or is `image/svg+xml` without `svgSanitized`. Every writer of a
 * published object takes its `Content-Type` from here, never from the stored value as it is.
 */
export function publicFormOf(contentType: string, svgSanitized = false): { contentType: string; extension: string } {
  const essence = mediaTypeEssence(contentType);
  const extension = essence === null ? undefined : EXTENSION_BY_TYPE[essence];
  if (essence === null || extension === undefined || (essence === SVG && !svgSanitized)) return { contentType: NEUTRAL_TYPE, extension: NEUTRAL_EXTENSION };
  return { contentType: essence, extension };
}
