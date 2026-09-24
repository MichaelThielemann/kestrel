# media/default
Uploads: bytes go to `blobstore@1` under `<prefix><folder>/<filename>`, metadata (`filename`,
`folder`, `contentType`, `size`, `key`, `checksum`, `status`, `createdAt`, `provenance`) into the
persistence collection `media_items`. `folder` is a path-like label (`2026/press`), tracked in `media_folders`, with
folder-tree operations (create/rename/remove) that move blobs along. `alt`, `title`, `description`
are per-locale texts (plain text: max 2000 characters, no control characters except tab and
newline, `VALIDATION` otherwise – they are not HTML and are never sanitized, which would rewrite legitimate
text such as `5 < 6`); `width`/`height` are read from the file header of PNG/JPEG/GIF/WebP uploads
(no image library). `provenance` records who made the file (`origin: human | ai | mixed | unknown`,
plus `tool`/`model`/`at`) and is exposed via `X-Content-Provenance` on download for every origin but
`human` — the anchor for labelling obligations such as EU AI Act Art. 50 (not legal advice;
labelling itself is the frontend's job). An upload without `provenance` is recorded as
`{ origin: "unknown" }`: a missing declaration is not evidence that a human made the file, and the
caller (the admin UI, an import script) is the one that knows.

Three key families share the blobstore, with three owners:

| Key | Owner | What it is |
|---|---|---|
| `media/<folder>/<file>` | this module (`prefix` configurable) | the original bytes, one blob per `media_items` row |
| `media-variants/<id>/<size>.webp` | `images/default` | the generated variants of a medium; this module ignores them in `media.reconcile` |
| `site/media/<folder>/<file>.<size>.webp` | `delivery-static` | the copies made at publish time (`prefix` + `media.target` there), referenced by the rendered HTML for static delivery |

The row is the truth, the blobstore only the storage. `media_items.key` is `unique`: a blob key
belongs to exactly one row, so two concurrent uploads of the same name in the same folder end as one
item and one `CONFLICT`, never as two rows over one blob. An upload writes the row first
(`status: "uploading"`, `checksum` = sha256 of the bytes as hex), then the blob, then
`status: "ready"`; a failing blob write leaves `status: "failed"` and returns the blobstore's
failure, so the pipeline still fails. Only `ready` items are returned by `media.get`, `media.list`
and `media.download` (`NOT_FOUND` / filtered out otherwise), and a `failed` row is replaced when the same name is uploaded
again, so a broken attempt never blocks a filename. `checksum` and `status` are additive: rows
written before them read as `checksum: null` / `status: "ready"`. Deleting removes the row first
and the blob after — but only once no other row points at that key — a failing blob delete is
logged, not fatal, and `media.reconcile` finds what is left over. A rename moves the blob first and
moves it back if the row update fails.

Uploading is idempotent: same folder, same filename and the same bytes return the item that is
already there — no second row, no second blob write, no second variant folder — and `media.upload`
then ends the pipeline itself (`ctx.done`, 200), so a following `events.emit:media.uploaded` does not
announce an upload that stored nothing. The same name with *different* bytes stays a `CONFLICT`
(409). For several files in one request, `ids` lists only what was newly stored; when nothing was,
the step ends the pipeline the same way.

Why: a plain blobstore has no metadata, folders, locale texts or provenance tracking; this module
adds the bookkeeping other modules (`delivery-static`, `references-default`) rely on, without
depending on an image library.

Config: `allowedTypes` (`image/*`, `application/pdf`, `*`), `deniedTypes` (default
`image/svg+xml`, `text/html`, `application/xhtml+xml` — they can carry scripts), `maxBytes`,
`prefix` (default `media/`, must end with `/`), `locales`/`defaultLocale`.

Steps: `media.upload` processes every file in `ctx.files`, in the order given, with the same checks
applied to each. A single file returns the item unchanged. Two or more files return
`{ items, errors, ids }`: `errors` holds one `{ filename, status, code, message }` entry per rejected
or conflicting file, and `ids` lists only the newly stored items — one bad file does not block the
rest, so the response is still 200. A `TRANSIENT` blobstore or database failure is the exception: it
is not per file, and fails the whole request. Other steps: `media.get`, `media.list` (folder, recursive, search, sort, ids, paging),
`media.listFolders`, `media.createFolder`, `media.renameFolder`, `media.listFolderItems` (for
`references.guardAll:media`), `media.removeFolder`, `media.update`, `media.download`,
`media.remove`, `media.reconcile`, `media.reconcileDelete`, `media.export:<dir>`.

Error codes per step (every step can also answer `TRANSIENT` when the blobstore or the database is
unavailable):

| Step | codes |
|---|---|
| `media.upload` | `VALIDATION` (no file, invalid folder or provenance), `UNSUPPORTED` (type not allowed), `PAYLOAD_TOO_LARGE` (over `maxBytes`), `CONFLICT` (filename taken by other bytes; `details.field: "key"`) |
| `media.get` | `VALIDATION` (unknown locale), `NOT_FOUND` |
| `media.list` | `VALIDATION` (invalid folder, unknown locale) |
| `media.update` | `VALIDATION` (name, folder, provenance or text), `NOT_FOUND`, `CONFLICT` (filename taken) |
| `media.download` | `NOT_FOUND` |
| `media.remove` | `VALIDATION` (missing id) |
| `media.createFolder` | `VALIDATION` |
| `media.renameFolder` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (target exists or is inside the source) |
| `media.listFolderItems` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (folder not empty and no `recursive`) |
| `media.removeFolder` | `VALIDATION`, `NOT_FOUND` |
| `media.listFolders`, `media.reconcile`, `media.reconcileDelete`, `media.export:<dir>` | – |

`media.reconcile` lists the blobs under `prefix` and compares them with the `media_items` keys:
`{ blobsWithoutRow, rowsWithoutBlob }`. With `delete: true` it deletes the blobs nothing points at;
`media.reconcileDelete` is the same step with the deletion fixed in the pipeline instead of the
request, so a route can offer the report and the cleanup as two different endpoints;
rows are never deleted, because a row is the only record that a file was ever meant to exist. Keys
under `media-variants/` are ignored — they belong to `images/default`, which this module cannot
query. A row of an upload that is in flight right now shows up under `rowsWithoutBlob`, so run it
from a cron trigger rather than after every write; no trigger is wired here, that is the
consumer's job.

## Behaviour

Filenames are capped at 200 bytes, and only after truncation checked for a trailing `.meta.json`,
which is rewritten to `-meta.json`; this order means truncating a filename can never accidentally
produce the internal metadata-sidecar suffix.

`media.list`'s `q` is a case-sensitive substring match on the filename.

`media.update` validates the whole patch, text fields included, before moving any blob, so a
rejected patch never leaves a moved blob without a matching row. Retrying a move that failed partway
finds the blob already at the target and only has to update the row.

At setup, item keys already on disk are migrated automatically to `<prefix><folder>/<filename>`. An
item whose folder or filename does not match what the sanitizing rules for uploads would produce, or
whose target key would end in `.meta.json`, is skipped and logged.

Not included: image resizing, tags, linking media to content documents.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-media-default` – module `media/default`: provides no contract; requires `blobstore@1`, `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `allowedTypes` | array | no | `["image/*","application/pdf"]` |
| `deniedTypes` | array | no | `["image/svg+xml","text/html","application/xhtml+xml"]` |
| `maxBytes` | integer | no | `5242880` |
| `locales` | array | no | `[]` |
| `defaultLocale` | string | no | – |
| `prefix` | string | no | `"media/"` |
| `publicPath` | string | no | `"/media"` |
| `publicCopy` | object | no | – |
| `publicCopy.prefix` | string | no | – |
| `uploadStaleAfterMs` | integer | no | `900000` |
| `anonymousList` | enum | no | `"ids"` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `media.upload` | Upload one or more files (multipart field `file`, repeatable). A single file returns the item; multiple files return per-file results. Idempotent: same folder, same filename and same bytes return the item that is already there, and the step then ends the pipeline itself (200), so no following step – notably events.emit:media.uploaded – runs for an upload that stored nothing | `files` | `result` | { folder?: string, provenance?: string } | object \| object (ends: object \| object) | 400 no file or invalid folder/provenance (per-file for a multi-file request); 409 the folder already has a file with that name, `details.field: "location"` (per-file for a multi-file request); the same bytes again are idempotent, not a conflict; 413 file exceeds maxBytes (per-file for a multi-file request); 415 type not allowed (per-file for a multi-file request) | – | no |
| `media.update` | Rename, move, set provenance or texts (alt/title/description per locale); the file's key and path never change | `params.id` | `result` | { filename?: string, folder?: string, provenance?: object, locale?: string, alt?: string \| null, title?: string \| null, description?: string \| null } ?locale: string | { id: string, path: string, filename: string, folder: string, contentType: string, size: number, createdAt: number, updatedAt: number, provenance: object, width: number \| null, height: number \| null, alt: string \| null, title: string \| null, description: string \| null } | 400 invalid name, folder or text (texts are plain text, max 2000 chars); 404 not found; 409 the folder already has a file with that name, `details.field: "location"` | – | no |
| `media.get` | Media metadata | `params.id` | `result` | ?locale: string | { id: string, path: string, filename: string, folder: string, contentType: string, size: number, createdAt: number, updatedAt: number, provenance: object, width: number \| null, height: number \| null, alt: string \| null, title: string \| null, description: string \| null } | 400 unknown locale; 404 not found | – | no |
| `media.list` | List media, newest first; anonymous callers may only fetch by ids | `identity?` | `result` | ?folder: string, recursive: boolean, q: string, sort: string, limit: integer, offset: integer, ids: string, locale: string | { items: object[], total: number, … } | 400 invalid folder or unknown locale; 401 no identity and no ids (unless anonymousList is "all") | – | no |
| `media.listFolders` | Folders (persistent and implied) with item counts; anonymous callers are refused | `identity?` | `result` | – | object[] | 401 no identity (unless anonymousList is "all") | – | no |
| `media.createFolder` | Create a folder (idempotent: an existing folder is returned unchanged) | – | `result` | { path: string } | { folder: string, count: number, … } | 400 missing or invalid path | – | no |
| `media.renameFolder` | Rename or move a folder (metadata only: keys and paths do not change) | `params.path` | `result` | { path: string } | { folder: string, moved: number, … } | 400 missing or invalid path; 404 folder not found; 409 target folder already exists | – | no |
| `media.listFolderItems` | Item ids in a folder, for use with references.guardAll:media before removeFolder | `params.path` | `result` | ?recursive: boolean | { path: string, ids: string[], … } | 400 missing or invalid path; 404 folder not found; 409 folder not empty (without `recursive`) | – | no |
| `media.removeFolder` | Delete a folder and everything in it (each item as media.remove) | `params.path` | `result` | – | { ok: boolean, removed: number, ids: string[], … } | 400 invalid path; 404 folder not found; 409 folder not empty or still referenced | – | no |
| `media.download` | The file itself | `params.id` | `result` | – | – | 404 not found | – | no |
| `media.serve` | The file at its public URL (params.id, params.name); the name must be the one it was uploaded under | `params.id`, `params.name` | `result` | – | – | 404 not found, not ready, or not the name the file was uploaded under | – | no |
| `media.remove` | Delete file and metadata (copy, blob, row, then a final sweep) | `params.id` | `result` | – | { ok: boolean, … } | 400 missing id | – | no |
| `media.reconcile` | Compare the blobs under the media prefix with the media_items rows; with `delete` also removes blobs that no row points at (rows are never deleted) | – | `result` | { delete?: boolean } | { blobsWithoutRow: string[], rowsWithoutBlob: string[], … } | – | – | no |
| `media.reconcileDelete` | Like media.reconcile, but always deletes the orphan blobs – the deletion is in the pipeline, not in the request | – | `result` | – | { blobsWithoutRow: string[], rowsWithoutBlob: string[], … } | – | – | no |
| `media.syncPublic` | Reconcile the public copies of every ready item's original with the stored items: fail abandoned uploads, write missing or mismatched copies, and remove copies of failed or deleted items and foreign files (adds _publicMedia: { written, removed, missing } to the result) | – | `result._publicMedia` | – | { _publicMedia: object, … } | – | – | no |
| `media.export:<arg>` | Copy every media item to <arg>/<folder>/<filename> | – | `result` | – | { written: number, skipped: number, missing: number, conflicts: number, … } | – | – | no |

Used by 14 of 89 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
