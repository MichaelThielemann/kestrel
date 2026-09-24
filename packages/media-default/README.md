# media/default
Uploads: bytes go to `blobstore@1` under `<prefix><id>/<name>` — one blob key per item, fixed at
upload and never touched again by a rename or a move. Metadata (`filename`, `folder`, `location`,
`contentType`, `size`, `key`, `checksum`, `status`, `createdAt`, `provenance`) goes into the
persistence collection `media_items`; only a public projection of it ever leaves the API (see
below). `folder` is a path-like label (`2026/press`), tracked in `media_folders`, with folder-tree
operations (create/rename/remove) that touch metadata only — a folder rename never moves a blob.
`alt`, `title`, `description` are per-locale texts (plain text: max 2000 characters, no control
characters except tab and newline, `VALIDATION` otherwise – they are not HTML and are never
sanitized, which would rewrite legitimate text such as `5 < 6`); `width`/`height` are read from the
file header of PNG/JPEG/GIF/WebP uploads (no image library). `provenance` records who made the file
(`origin: human | ai | mixed | unknown`, plus `tool`/`model`/`at`) and is exposed via
`X-Content-Provenance` on download and on the public URL for every origin but `human` — the anchor
for labelling obligations such as EU AI Act Art. 50 (not legal advice; labelling itself is the
frontend's job). An upload without `provenance` is recorded as `{ origin: "unknown" }`: a missing
declaration is not evidence that a human made the file, and the caller (the admin UI, an import
script) is the one that knows.

## One public URL per file

Every item has exactly one public URL, `path`: `<publicPath>/<id>/<name>` (default `publicPath`:
`/media`). `<name>` is decided once, at upload, from the sent filename reduced to
`[A-Za-z0-9._-]` with the extension of the content type (`Photo 1.JPG` sent as `image/jpeg` becomes
`Photo-1.jpg`, so a static host that derives `Content-Type` from the extension serves the right one);
it never changes again. `media.update`'s `filename` only changes the *display* name from then on —
neither the blob key nor `path` ever move, so renaming or moving an item needs no republish anywhere
it is linked. A name still has to be unique per folder: the check runs against an internal
`location` column (`folder + display filename`), never against the id-based blob key; a clash
answers 409 with `details.field: "location"`.

New step `media.serve` answers a file at its public URL (`params.id`, `params.name`): the name must
be exactly the one the item carries, or the request is `NOT_FOUND` — this is what makes `path`
resolve on a plain origin, with no `/api` prefix. It is cacheable for a year as `immutable`, since
the bytes behind a given `path` never change.

With `publicCopy: { prefix }` configured, this module also keeps a copy of every `ready` item's
original at `<publicCopy.prefix><publicPath without its leading "/">/<id>/<name>` (e.g.
`site/media/<id>/photo.jpg`) — written by the same step that makes the original visible (upload) and
removed when the item is deleted, so a static export or a bucket served directly needs no separate
build step for media. New step `media.syncPublic` reconciles that copy tree with the stored items
(`{ written, removed, missing }`): it fails an `uploading` row stuck longer than
`uploadStaleAfterMs` (default 15 minutes, an abandoned upload) the same way a normal failure is
handled, writes a missing or mismatched copy, and removes a copy whose item is gone or whose file no
longer matches — never touching anything deeper than one path segment under `<id>/`, since that is
where `images-default`'s own variant copies live. It pages through the items by id, re-reads an
item after writing its copy and removes the copy again when the item was deleted meanwhile, and
reads a file's item once more right before removing the file, so an upload or a delete running at
the same time never leaves a deleted item's copy behind or costs a ready item its copy. Boot fails if the copy tree and this module's own
storage `prefix` overlap, if `publicCopy` is set but no pipeline runs `media.serve`, or if a pipeline
runs `media.syncPublic` without `publicCopy` set.

Three key families share the blobstore, with three owners:

| Key | Owner | What it is |
|---|---|---|
| `media/<id>/<name>` | this module (`prefix` configurable) | the original bytes, one blob per `media_items` row |
| `media-variants/<id>/<size>.<ext>` | `images/default` | the generated variants of a medium; this module ignores them in `media.reconcile` |
| `site/media/<id>/<name>` and `site/media/<id>/variants/<size>.<ext>` | this module and `images/default`, each writing only its own depth-1 files | the public copies, served directly by a static host or a bucket in front of the origin |

The row is the truth, the blobstore only the storage. `media_items.key` is `unique`, and is always
id-based, so it never collides on its own; the folder+filename clash check runs against `location`
instead (see above). An upload writes the row first (`status: "uploading"`, `checksum` = sha256 of
the bytes as hex), then the private blob, then (if `publicCopy` is set) the public copy, then
`status: "ready"`. A failing blob or copy write leaves `status: "failed"` and returns the
blobstore's failure, so the pipeline still fails; a failing `ready` update returns the store's
error and leaves the row `uploading`, which the next `media.syncPublic` marks `failed` once it is
older than `uploadStaleAfterMs`, removing its copy and blob and freeing the name. Only `ready` items are returned by `media.get`,
`media.list` and `media.download` (`NOT_FOUND` / filtered out otherwise), and a `failed` row is
replaced when the same name is uploaded again, so a broken attempt never blocks a filename.
`media.remove` and `media.removeFolder` remove the public copy, then the private blob, then the row,
then sweep the item's own files once more — so a retry after a partial failure completes, and a
failing blob delete fails the step.

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
`prefix` (default `media/`, must end with `/`), `publicPath` (default `/media`), `publicCopy`
(optional `{ prefix }`), `uploadStaleAfterMs` (default 15 minutes), `anonymousList` (`"ids"` default,
or `"all"` for a public catalogue), `locales`/`defaultLocale`.

## Anonymous reads

`media.get`, `media.serve` and `images.serve` answer an anonymous caller the same as a signed-in one
(a file's URL is meant to be public once a page links it). `media.list` and `media.listFolders` are
different: without a signed-in caller, `media.list` answers only when the request names `ids`
explicitly (401 `UNAUTHENTICATED` otherwise), and `media.listFolders` always needs a signed-in
caller. Set `anonymousList: "all"` to restore anonymous listing for a deployment that wants a public
media catalogue; it is never the default.

Steps: `media.upload` processes every file in `ctx.files`, in the order given, with the same checks
applied to each. A single file returns the item unchanged. Two or more files return
`{ items, errors, ids }`: `errors` holds one `{ filename, status, code, message }` entry per rejected
or conflicting file, and `ids` lists only the newly stored items — one bad file does not block the
rest, so the response is still 200. A `TRANSIENT` blobstore or database failure is the exception: it
is not per file, and fails the whole request. Other steps: `media.get`, `media.list` (folder, recursive, search, sort, ids, paging),
`media.listFolders`, `media.createFolder`, `media.renameFolder`, `media.listFolderItems` (for
`references.guardAll:media`), `media.removeFolder`, `media.update`, `media.download`, `media.serve`,
`media.remove`, `media.reconcile`, `media.reconcileDelete`, `media.syncPublic`, `media.export:<dir>`.

Error codes per step (every step can also answer `TRANSIENT` when the blobstore or the database is
unavailable):

| Step | codes |
|---|---|
| `media.upload` | `VALIDATION` (no file, invalid folder or provenance), `UNSUPPORTED` (type not allowed), `PAYLOAD_TOO_LARGE` (over `maxBytes`), `CONFLICT` (name taken in that folder; `details.field: "location"`) |
| `media.get` | `VALIDATION` (unknown locale), `NOT_FOUND` |
| `media.list` | `VALIDATION` (invalid folder, unknown locale), `UNAUTHENTICATED` (no identity and no `ids`, unless `anonymousList: "all"`) |
| `media.listFolders` | `UNAUTHENTICATED` (no identity, unless `anonymousList: "all"`) |
| `media.update` | `VALIDATION` (name, folder, provenance or text), `NOT_FOUND`, `CONFLICT` (name taken in that folder) |
| `media.download`, `media.serve` | `NOT_FOUND` |
| `media.remove` | `VALIDATION` (missing id) |
| `media.createFolder` | `VALIDATION` |
| `media.renameFolder` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (target exists or is inside the source) |
| `media.listFolderItems` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (folder not empty and no `recursive`) |
| `media.removeFolder` | `VALIDATION`, `NOT_FOUND` |
| `media.reconcile`, `media.reconcileDelete`, `media.syncPublic`, `media.export:<dir>` | – |

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

`media.update` validates the whole patch, text fields included, before touching the row; it never
calls the blobstore, since neither a rename nor a move ever changes a key.

No data migration: setup fails on start if a stored item's key is not `<prefix><id>/<name>`, naming
the first such item and the count of items affected. A store from a version before this scheme must
start empty.

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
