/**
 * The extension of every media type a published file may be served as: types a browser shows or offers
 * as a download from a static host, never one it opens as a document that runs script (no HTML, XHTML,
 * XML or JavaScript). `image/svg+xml` is listed, but {@link publicFormOf} publishes an SVG as one only
 * when its bytes passed `sanitize.svg`. Entries are only ever added, never changed or removed: a stored
 * name keeps its extension, and one that no longer matches its type's entry is published as `.bin`.
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
const PARAMETER = new RegExp(`[\\t ]*;[\\t ]*(?:(${TOKEN})=(${TOKEN}|${QUOTED}))?`, "y");
const TRAILING = /[\t ]*$/y;
const QUOTE = '"';
const SUFFIX_WILDCARD = "*+";

/** A declared content type that is exactly one media type, reduced to what is kept of it. */
export interface MediaType {
  /** `type/subtype`, lower-cased. */
  essence: string;
  /** The first `charset` parameter, lower-cased, when its value is a token; `null` otherwise, and for a quoted value. */
  charset: string | null;
}

/**
 * Parses a declared content type that is exactly one media type as RFC 9110 defines it: a type and a
 * subtype of token characters, optionally followed by `;` parameters, with no comma anywhere. `null` for
 * anything else — an empty string, a list of types, a stray character — since a browser reading a list
 * uses the last type in it.
 */
export function parseMediaType(declared: string): MediaType | null {
  if (declared.includes(",")) return null;
  ESSENCE.lastIndex = 0;
  const essence = ESSENCE.exec(declared);
  if (essence === null) return null;
  let charset: string | null | undefined;
  let at = ESSENCE.lastIndex;
  for (;;) {
    PARAMETER.lastIndex = at;
    const parameter = PARAMETER.exec(declared);
    if (parameter === null) break;
    at = PARAMETER.lastIndex;
    const [, name, value] = parameter;
    if (charset === undefined && name !== undefined && value !== undefined && name.toLowerCase() === "charset") charset = value.startsWith(QUOTE) ? null : value.toLowerCase();
  }
  TRAILING.lastIndex = at;
  if (!TRAILING.test(declared)) return null;
  return { essence: `${essence[1]}/${essence[2]}`.toLowerCase(), charset: charset ?? null };
}

/** The lower-cased `type/subtype` of a declared content type, or `null` unless it is exactly one media type (see {@link parseMediaType}). */
export function mediaTypeEssence(declared: string): string | null {
  return parseMediaType(declared)?.essence ?? null;
}

/**
 * Whether a media type matches one `allowedTypes`/`deniedTypes` pattern. `*` matches every type, and so
 * does a pattern whose type and subtype are both `*`; `type/*` matches every type of that top-level type
 * (`image/*` matches `image/png`); `type/*+suffix` matches every type of that top-level type whose
 * subtype is longer than `+suffix` and ends in it (`image/*+xml` matches `image/svg+xml`, not
 * `image/+xml`), and the same pattern with `*` as its type does so for every top-level type; any other
 * pattern matches the one type it names. Case and parameters are ignored on both sides. A pattern that
 * is none of these — empty, a list of types, stray characters — matches nothing, and so does a
 * `mediaType` that is not exactly one media type.
 */
export function mediaTypeMatches(pattern: string, mediaType: string): boolean {
  const type = mediaTypeEssence(mediaType);
  if (type === null) return false;
  if (pattern.trim() === "*") return true;
  const wanted = mediaTypeEssence(pattern);
  if (wanted === null) return false;
  if (wanted === "*/*") return true;
  const slash = wanted.indexOf("/");
  const wantedType = wanted.slice(0, slash);
  const wantedSubtype = wanted.slice(slash + 1);
  if (wantedSubtype === "*") return type.startsWith(`${wantedType}/`);
  if (wantedSubtype.startsWith(SUFFIX_WILDCARD) && wantedSubtype.length > SUFFIX_WILDCARD.length) {
    const typeSlash = type.indexOf("/");
    const subtype = type.slice(typeSlash + 1);
    const suffix = wantedSubtype.slice(1);
    return (wantedType === "*" || type.slice(0, typeSlash) === wantedType) && subtype.length > suffix.length && subtype.endsWith(suffix);
  }
  return wanted === type;
}

/** Whether a media type matches at least one `allowed` pattern and no `denied` pattern, each as {@link mediaTypeMatches} decides, including the `type/*+suffix` form. */
export function mediaTypeAllowed(allowed: readonly string[], denied: readonly string[], mediaType: string): boolean {
  return allowed.some((pattern) => mediaTypeMatches(pattern, mediaType)) && !denied.some((pattern) => mediaTypeMatches(pattern, mediaType));
}

function canonicalOf(parsed: MediaType): string {
  return parsed.essence.startsWith("text/") && parsed.charset !== null ? `${parsed.essence}; charset=${parsed.charset}` : parsed.essence;
}

/**
 * The form a declared content type is stored in: its lower-cased `type/subtype`, plus `; charset=<value>`
 * for a `text/*` type whose `charset` parameter is a token (`Text/Plain; Charset=Latin1; format=flowed`
 * becomes `text/plain; charset=latin1`). No other parameter survives. `null` unless it is exactly one
 * media type (see {@link parseMediaType}).
 */
export function canonicalMediaType(declared: string): string | null {
  const parsed = parseMediaType(declared);
  return parsed === null ? null : canonicalOf(parsed);
}

/**
 * How a stored type is published wherever a host serves it without an access check (a public copy, a
 * variant path, its public URL, its download): its {@link canonicalMediaType} form and that type's
 * extension from {@link EXTENSION_BY_TYPE}, or {@link NEUTRAL_TYPE} and {@link NEUTRAL_EXTENSION} when
 * the type is not listed, is not exactly one media type, or is `image/svg+xml` without `svgSanitized`.
 * Every writer of a published object takes its `Content-Type` from here, never from the stored value as
 * it is.
 */
export function publicFormOf(contentType: string, svgSanitized = false): { contentType: string; extension: string } {
  const parsed = parseMediaType(contentType);
  const extension = parsed === null ? undefined : EXTENSION_BY_TYPE[parsed.essence];
  if (parsed === null || extension === undefined || (parsed.essence === SVG && !svgSanitized)) return { contentType: NEUTRAL_TYPE, extension: NEUTRAL_EXTENSION };
  return { contentType: canonicalOf(parsed), extension };
}
