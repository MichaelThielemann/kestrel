/** The extension of every media type a file's public URL may carry as it is: types a browser shows or downloads but never runs. `image/svg+xml` is on the list only because a public copy of an SVG requires `sanitize.svg` before `media.upload` (checked at boot). */
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
  "application/zip": "zip",
};

/** The content type a file of an unlisted type is published with; every host serves it as a download. */
export const NEUTRAL_TYPE = "application/octet-stream";

/** The extension a file of an unlisted type is published with. */
export const NEUTRAL_EXTENSION = "bin";

/** The media type of a content type: the part before any parameters, trimmed and lower-cased. */
export function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** How a stored file is published: its own content type and that type's extension when the type is listed, else `application/octet-stream` and `bin`. Never derived from the uploaded name. */
export function publicFormOf(contentType: string): { contentType: string; extension: string } {
  const extension = EXTENSION_BY_TYPE[mediaTypeOf(contentType)];
  return extension === undefined ? { contentType: NEUTRAL_TYPE, extension: NEUTRAL_EXTENSION } : { contentType, extension };
}
