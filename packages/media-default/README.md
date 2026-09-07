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

The row is the truth, the blobstore only the storage. An upload writes the row first
(`status: "uploading"`, `checksum` = sha256 of the bytes as hex), then the blob, then
`status: "ready"`; a failing blob write leaves `status: "failed"` and returns the blobstore's
failure, so the pipeline still fails. Only `ready` items are returned by `media.get`, `media.list`
and `media.download` (`NOT_FOUND` / filtered out otherwise), and a `failed` row is replaced when the same name is uploaded
again, so a broken attempt never blocks a filename. `checksum` and `status` are additive: rows
written before them read as `checksum: null` / `status: "ready"`. Deleting removes the row first
and the blob after — a failing blob delete is logged, not fatal, and `media.reconcile` finds what
is left over. A rename moves the blob first and moves it back if the row update fails.

Why: a plain blobstore has no metadata, folders, locale texts or provenance tracking; this module
adds the bookkeeping other modules (`delivery-static`, `references-default`) rely on, without
depending on an image library.

Config: `allowedTypes` (`image/*`, `application/pdf`, `*`), `deniedTypes` (default
`image/svg+xml`, `text/html`, `application/xhtml+xml` — they can carry scripts), `maxBytes`,
`prefix` (default `media/`, must end with `/`), `locales`/`defaultLocale`.

Steps: `media.upload` (processes every file in `ctx.files`, in order, with the same checks; exactly
one file returns the item unchanged, two or more return `{ items, errors, ids }` with a per-file
`{ filename, status, code, message }` entry in `errors` — a rejected or conflicting file doesn't stop
the others, partial success is a 200; a `TRANSIENT` blobstore or database failure is not per-file and
fails the whole request), `media.get`, `media.list` (folder, recursive, search, sort, ids, paging),
`media.listFolders`, `media.createFolder`, `media.renameFolder`, `media.folderItems` (for
`references.guardAll:media`), `media.removeFolder`, `media.update`, `media.download`,
`media.remove`, `media.reconcile`, `media.reconcileDelete`, `media.export:<dir>`.

Error codes per step (every step can also answer `TRANSIENT` when the blobstore or the database is
unavailable):

| Step | codes |
|---|---|
| `media.upload` | `VALIDATION` (no file, invalid folder or provenance), `UNSUPPORTED` (type not allowed), `PAYLOAD_TOO_LARGE` (over `maxBytes`), `CONFLICT` (filename taken) |
| `media.get` | `VALIDATION` (unknown locale), `NOT_FOUND` |
| `media.list` | `VALIDATION` (invalid folder, unknown locale) |
| `media.update` | `VALIDATION` (name, folder, provenance or text), `NOT_FOUND`, `CONFLICT` (filename taken) |
| `media.download` | `NOT_FOUND` |
| `media.remove` | `VALIDATION` (missing id) |
| `media.createFolder` | `VALIDATION` |
| `media.renameFolder` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (target exists or is inside the source) |
| `media.folderItems` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (folder not empty and no `recursive`) |
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

Not included: image resizing, tags, linking media to content documents.
