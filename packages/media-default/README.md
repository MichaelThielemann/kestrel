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
`/media`). `<name>` is decided once, at upload, and never changes again — with one exception: it is
demoted to `.bin` when its file may no longer be published as the type its extension names (see
below).

A declared image type or `application/pdf` is checked against the file's leading bytes
(`verifiedMediaType`): when they identify another type — PNG bytes sent as `image/jpeg`, SVG or HTML
markup sent as `image/png` — the upload is treated as that type from here on, for `allowedTypes`,
`deniedTypes`, the stored type and the name's extension. A type the bytes are refused as names both
(`type "image/svg+xml" (declared as "image/png") is not allowed`). Bytes that match no known signature
keep the declared type, and every other declared type is taken as declared. An ISO image file (AVIF, HEIC, HEIF) keeps
a declared type that any of its brands names, and counts as AVIF when one brand is AVIF. Markup counts as
SVG only when `<svg` starts within its first 4 KiB; an SVG with a longer prologue (comments, a large
doctype) sent as an image type is treated as HTML or XML and meets `deniedTypes` accordingly.

The declared content type has to be exactly one media type: `type/subtype` of RFC 9110 token
characters, optionally followed by `;` parameters, with no comma. Anything else — a list such as
`image/png; x=1, text/html` (a browser uses the last type of a list), or an empty type — is refused
as `UNSUPPORTED` (415). What is stored and written to the blob store is the lower-cased
`type/subtype`, plus the `charset` of a `text/*` type when its value is a token, lower-cased; no other
parameter survives: `IMAGE/PNG; x=1` is stored as `image/png`, `Text/Plain; Charset=UTF-8;
format=flowed` as `text/plain; charset=utf-8`. `allowedTypes`/`deniedTypes` entries are patterns,
matched by `mediaTypeMatches` from `@michaelthielemann/kestrel-contracts/helpers/mediaType` against the
`type/subtype` alone, ignoring parameters and case on both sides: `*` and `*/*` match every type,
`image/*` every image type, `image/*+xml` every image type whose subtype ends in `+xml` (`*/*+xml` the
same for every top-level type), `image/png` that one type, and any other entry — a list, a bare
`image`, an empty string — nothing. A type is accepted when it matches an `allowedTypes` entry and no
`deniedTypes` entry (`mediaTypeAllowed`); `deniedTypes: ["*/*"]` refuses every upload and counts as
denying SVG for the boot check below. A static host that
types a file by its extension decides the charset itself; the stored one reaches only a host that
sends the stored header (a bucket), `media.serve` and `media.download`.

`<name>`'s extension comes from that stored type, never from the uploaded name, so the checks on the
type (`allowedTypes`, `deniedTypes`, `sanitize.svg`) and the type a static host serves by the
extension are always the same one:

- a listed type (images, PDF, audio, video, `text/plain`, `text/csv`, JSON, office documents such as
  DOCX, XLSX, PPTX, ODT, ODS and ODP, and archives such as ZIP; see `EXTENSION_BY_TYPE` in
  `@michaelthielemann/kestrel-contracts/helpers/mediaType`) gets its own extension, replacing the uploaded
  one: `Photo 1.JPG` sent as `image/jpeg` becomes `Photo-1.jpg`, `x.html.png` sent as `image/png`
  becomes `x-html.png`. None of them is a type a browser runs as a document;
- every other type gets `.bin` and keeps the uploaded extension in the stem: `x.html` sent as
  `image/x-foo` or `text/html` becomes `x-html.bin`, `app.js` sent as `text/javascript` becomes
  `app-js.bin`. Its public copy is stored as `application/octet-stream`, and `media.serve` and
  `media.download` answer with that type too, so every host offers it as a download and no browser
  runs it;
- an SVG is listed, but only an SVG whose bytes passed `sanitize.svg` is stored as `<name>.svg` and
  served as `image/svg+xml`. `media.upload` records that per row, from what `attach()` found out
  about the pipeline it runs in: `sanitize.svg` runs before it, and no step in between declares a
  write to `files`. Nothing in the request can set it, and a run the booted instance did not start —
  one through the `testing/runPipeline` helper, say — never counts as sanitising. Every other SVG is
  stored and served like an unlisted type (`logo.svg` becomes `logo-svg.bin`,
  `application/octet-stream`).

Every writer of a public copy — this module's upload and `media.syncPublic`, and `images-default`'s
variants and placeholders — and every step that answers a file (`media.serve`, `media.download`,
`images.serve`) takes the `Content-Type` from `publicFormOf` in the same helper, never from the
stored value as it is, and the published name is the stored one. A name stored as `.bin` stays `.bin`
and is published as `application/octet-stream`, also once the list holds its type (`archive-7z.bin`
stored while 7Z was not listed keeps that name and type), so the name and the type always agree for a
static host that types by extension. A name that ends in the extension its type is listed with is
published with that type. Any other name is demoted: every `.` turned into `-`, plus `.bin`, published
as `application/octet-stream` — an SVG stored without the `sanitize.svg` record (`logo.svg` as
`logo-svg.bin`), a row that holds a type this version refuses (a list, an empty type). `path`,
`media.serve` and the public copy follow the demoted name. The list therefore only ever grows: a
type's extension never changes and a type never leaves it.

The stem is the uploaded name reduced to `[A-Za-z0-9_-]`: any other dot becomes `-`, so a name
carries exactly one extension and a host that maps several extensions (`x.html.png`) sees only the
last. Case does not matter anywhere (`X.HTML`, `IMAGE/PNG`). A name is therefore never `variants` or
`file`, the variants directory and the download route next to it. `media.update`'s `filename` only changes the *display* name from then on —
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
removed when the item is deleted, so a static export or a bucket whose `site/*` is served directly needs no separate
build step for media. New step `media.syncPublic` reconciles that copy tree with the stored items
(`{ written, removed, missing }`): it fails an `uploading` row stuck longer than
`uploadStaleAfterMs` (default 15 minutes, an abandoned upload) the same way a normal failure is
handled, writes a missing or mismatched copy, and removes a copy whose item is gone or whose file no
longer matches — never touching anything deeper than one path segment under `<id>/`, since that is
where `images-default`'s own variant copies live. An SVG, the one listed type a browser can run
script in, reaches the copy as `image/svg+xml` only after `sanitize.svg`: with `publicCopy` set and
SVG uploads allowed by `allowedTypes`/`deniedTypes`, boot fails unless every pipeline that runs
`media.upload` runs `sanitize.svg` before it, with no step in between that declares a write to
`files`. An SVG stored without it — uploaded while `publicCopy` was off, through a pipeline without
`sanitize.svg` — keeps its `.bin` name and `application/octet-stream` type after `publicCopy` is
turned on, and every write of its copy logs a warning naming the row's id. Serve the copy tree with `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox`, as the Node origin does, so a host never guesses a type or runs
a document from it. It pages through the items by id, so an item
deleted or added during the run never makes it skip another, and re-reads an item after writing its
copy and removes the copy again when the item was deleted meanwhile; an upload or a delete running at
the same time therefore never leaves a deleted item's copy behind or costs a ready item its copy. It
marks an upload `failed` only while the row is still `uploading`, and an upload turns its row `ready`
only under the same condition: when the sync abandoned it first, the upload removes what it wrote and
answers `TRANSIENT`. This holds as long as only an upload and the sync itself write depth-1 files in
the copy tree, and the persistence module orders ids the same way for `sort: { id: "asc" }` and
`{ id: { gt } }`, as every bundled one does. Boot fails if the copy tree and this module's own
storage `prefix` overlap, if `publicCopy` is set but no pipeline runs `media.serve`, or if a pipeline
runs `media.syncPublic` without `publicCopy` set.

These key families share the blobstore when every module uses its default prefix:

| Key | Owner | What it is | Public |
|---|---|---|---|
| `media/<id>/<name>` | this module (`prefix` configurable) | the original bytes, one blob per `media_items` row, including items that are still uploading or were never made public | no |
| `media-variants/<id>/<size>.<ext>` | `images/default` (its own `prefix`) | the generated variants of a medium; `media.reconcile` never considers them, see below | no |
| `site/media/<id>/<name>` and `site/media/<id>/variants/<size>.<ext>` | this module and `images/default`, each writing only its own depth-1 files | the public copies, served directly by a static host or a bucket in front of the origin | yes |
| `site/…` (pages, `redirects.json`, `llms.txt`) | `delivery/static`, `redirects/default` | the static export | yes |
| `replica/gen/<generation>/…` | `replication/sqlite` (`prefix`) | snapshots and WAL segments of the whole database: sessions, password hashes, drafts | no |
| the `key` of `backup/blobstore` | `backup/blobstore` | a copy of the database file | no |

Only the public copy tree may be readable without credentials. A bucket that is served directly
grants anonymous read on `site/*` alone, never on the whole bucket; with an S3 bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::example-bucket/site/*"
    }
  ]
}
```

With a bucket-wide `prefix` on `blobstore-s3` (say `kestrel/`), every key above gains it, and the
resource becomes `arn:aws:s3:::example-bucket/kestrel/site/*`. No `s3:ListBucket` for anonymous
callers either.

The original's URL and its variants' URLs share one directory per item, so `publicPath` and
`publicCopy` must be configured identically on this module and on `images-default`. Their private
`prefix`es should differ: `images-default` removes everything under `<its prefix><id>/` when it
removes an item's variants, which with an equal `prefix` includes the original.

The row is the truth, the blobstore only the storage. `media_items.key` is `unique`, and is always
id-based, so it never collides on its own; the folder+filename clash check runs against `location`
instead (see above). An upload writes the row first (`status: "uploading"`, `checksum` = sha256 of
the bytes as hex), then the private blob, then (if `publicCopy` is set) the public copy, then
`status: "ready"`. A failing blob or copy write leaves `status: "failed"` and returns the
blobstore's failure, so the pipeline still fails; a failing `ready` update returns the store's
error and leaves the row `uploading`. Such a row, and one left by a blob store that threw, counts
as abandoned once it is older than `uploadStaleAfterMs`: the next upload of the same name, and with
`publicCopy` the next `media.syncPublic`, mark it `failed` and remove its copy and blob, which frees
the name. Only `ready` items are returned by `media.get`,
`media.list`, `media.download`, `media.serve`, `media.export:<dir>` and `media@1` (`NOT_FOUND` /
filtered out otherwise), and a `failed` row is replaced when the same name is uploaded again, so a
broken attempt never blocks a filename. `media.remove` and `media.removeFolder` first end the item's
readiness (`status: "removing"`), then remove the public copy, then the private blob, then the row,
then sweep the item's own files once more. From the first of these writes on the item is answered by
nothing: `media.serve` and `media.download` answer 404 while a delete is under way, and no reader
meets a ready item without its bytes. A failing blob delete fails the step and leaves an item a user
can no longer see or trip over: its name is free and it counts in no folder. Whatever meets it next
finishes it — repeating the delete, an upload, rename or move to its name, a folder rename or
delete, `media.update` of its id (which then answers 404), `media.syncPublic` — and every start of
the module finishes each such item before it answers anything, with or without `publicCopy`. Each
item is finished on its own: one the start cannot finish — the blob store answers an error or throws —
is logged with its id and left for the next start, and the start goes on with the others and never
fails because of it.

Uploading is idempotent: same folder, same filename and the same bytes return the item that is
already there — no second row, no second blob write, no second variant folder — and `media.upload`
then ends the pipeline itself (`ctx.done`, 200), so a following `events.emit:media.uploaded` does not
announce an upload that stored nothing. The same name with *different* bytes stays a `CONFLICT`
(409). For several files in one request, `ids` lists only what was newly stored; when nothing was,
the step ends the pipeline the same way.

Why: a plain blobstore has no metadata, folders, locale texts or provenance tracking; this module
adds that bookkeeping, and other modules read the ready files through `media@1`, without depending
on an image library.

## Provides `media@1`

The instance is also a `media@1` provider (`@michaelthielemann/kestrel-contracts/media`): `file`,
`files`, `load` (the description and the stored bytes, from one read of the item), `scan` (ready
files by type pattern and creation time, paged by id, so a cursor resumes in another process) and
`count`. Only a `ready` item is visible; `uploading`, `failed` and `removing` rows never are. A
`MediaFile` carries `contentType` as stored, `publishedType` — the type `media.serve`,
`media.download` and the public copy send (`application/octet-stream` for a name stored as `.bin`) —
`size`, the `width`/`height` read at upload, `folder`, the display `filename` and `createdAt`; never
the storage key. `load` answers `null` for a ready item whose bytes are missing from the blob store
and logs it, and answers `null` without a log when the item's delete began meanwhile. `scan` and
`count` page through the rows by id alone (plus `createdAt` for `createdSince`) and decide readiness
and type in code, so a store that counts the rows left on every page counts them on its key; `scan`
reads a page the size of its `limit` first and doubles it only while rows are left out; `count` of one `*`, `type/*` or exact pattern (not a `text/*`
type) without `excludeTypes` is a single store count, any other filter counts through a scan. Every
method notes its reads like `media.get` and `media.list` do: a `document` read per id asked of
`file`, `files` and `load`, a `type` read per `scan` and `count`.

Config: `allowedTypes` (`image/*`, `application/pdf`, `*` or `*/*`), `deniedTypes` (default
`image/svg+xml`, `text/html`, `application/xhtml+xml` — they can carry scripts; both lists are
patterns matched against the media type without parameters, ignoring case, see above), `maxBytes`,
`prefix` (default `media/`, must end with `/`), `publicPath` (default `/media`), `publicCopy`
(optional `{ prefix }`), `uploadStaleAfterMs` (default 15 minutes), `anonymousList` (`"ids"` default,
or `"all"` for a public catalogue), `locales`/`defaultLocale`.

## Anonymous reads

`media.get`, `media.serve` and `images.serve` answer an anonymous caller the same as a signed-in one
(a file's URL is meant to be public once a page links it). `media.list` and `media.listFolders` are
different: without a signed-in caller, `media.list` answers only when the request names `ids`
explicitly (401 `UNAUTHENTICATED` otherwise), and `media.listFolders` always needs a signed-in
caller. Set `anonymousList: "all"` to restore anonymous listing for a deployment that wants a public
media catalogue; it is never the default. Which fields of an item an anonymous caller receives is up
to the pipeline's last step, `authz-roles`' `authz.fields:media`: `examples/minimal` grants `id`,
`path`, `filename`, `contentType`, `size`, `width`, `height`, `alt`, `title`, `description`,
`provenance` and the variants' `size`, `width`, `height`, `format` and `path`, so `folder`,
`createdAt`, `updatedAt` and the render state stay with signed-in callers.

Steps: `media.upload` processes every file in `ctx.files`, in the order given, with the same checks
applied to each. A single file returns the item unchanged. Two or more files return
`{ items, errors, ids }`: `errors` holds one `{ filename, status, code, message }` entry per rejected
or conflicting file, and `ids` lists only the newly stored items — one bad file does not block the
rest, so the response is still 200. A `TRANSIENT` blobstore or database failure is the exception: it
is not per file, and fails the whole request. Other steps: `media.get`, `media.list` (folder, recursive, search, sort, canonical type, ids, paging),
`media.listFolders`, `media.createFolder`, `media.renameFolder`, `media.listFolderItems` (for
`references.guardAll:media`), `media.removeFolder`, `media.update`, `media.download`, `media.serve`,
`media.remove`, `media.reconcile`, `media.reconcileDelete`, `media.syncPublic`, `media.export:<dir>`.

`media.list`'s `image`/`video` kind filters at the store, one content-type prefix, with a store-counted
total. Its text query (`q`) and its `other` kind cannot be expressed as a store filter, so each scans
every ready item in scope instead, in batches of 500 (the same pattern `folders()` and the
recursive-folder branch already use), before paging and counting in memory: bounded memory, O(N) time,
a correct total.

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
rows are never deleted, because a row is the only record that a file was ever meant to exist. A key
is reported only when it has this module's own shape, `<prefix><id>/<name>` with exactly one segment
for each, and no item has that id at all. Anything else under `prefix` is never reported or deleted:
`images-default`'s variants whether its `prefix` lies under this one (`media/variants/` under
`media/`) or equals it (`media/<id>/thumb.webp` next to the original), a file directly under
`prefix`, a deeper key, or any file under the id of an item that exists. A row of an upload that is in flight right now shows up under `rowsWithoutBlob`, so run it
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
`@michaelthielemann/kestrel-media-default` – module `media/default`: provides `media@1`; requires `blobstore@1`, `persistence@1`.

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
| `media.list` | List media, newest first; anonymous callers may only fetch by ids | `identity?` | `result` | ?folder: string, recursive: boolean, q: string, sort: string, type: "image" \| "video" \| "other", limit: integer, offset: integer, ids: string, locale: string | { items: object[], total: number, … } | 400 invalid folder, unknown locale or invalid type; 401 no identity and no ids (unless anonymousList is "all") | – | no |
| `media.listFolders` | Folders (persistent and implied) with item counts; anonymous callers are refused | `identity?` | `result` | – | object[] | 401 no identity (unless anonymousList is "all") | – | no |
| `media.createFolder` | Create a folder (idempotent: an existing folder is returned unchanged) | – | `result` | { path: string } | { folder: string, count: number, … } | 400 missing or invalid path | – | no |
| `media.renameFolder` | Rename or move a folder (metadata only: keys and paths do not change) | `params.path` | `result` | { path: string } | { folder: string, moved: number, … } | 400 missing or invalid path; 404 folder not found; 409 target folder already exists | – | no |
| `media.listFolderItems` | Item ids in a folder, for use with references.guardAll:media before removeFolder | `params.path` | `result` | ?recursive: boolean | { path: string, ids: string[], … } | 400 missing or invalid path; 404 folder not found; 409 folder not empty (without `recursive`) | – | no |
| `media.removeFolder` | Delete a folder and everything in it (each item as media.remove) | `params.path` | `result` | – | { ok: boolean, removed: number, ids: string[], … } | 400 invalid path; 404 folder not found; 409 folder not empty or still referenced | – | no |
| `media.download` | The file itself | `params.id` | `result` | – | – | 404 not found | – | no |
| `media.serve` | The file at its public URL (params.id, params.name); the name must be the one it was uploaded under | `params.id`, `params.name` | `result` | – | – | 404 not found, not ready, or not the name the file was uploaded under | – | no |
| `media.remove` | Delete file and metadata: end the item's readiness, then remove copy, blob and row, then a final sweep | `params.id` | `result` | – | { ok: boolean, … } | 400 missing id | – | no |
| `media.reconcile` | Compare the blobs under the media prefix with the media_items rows; with `delete` also removes blobs that no row points at (rows are never deleted) | – | `result` | { delete?: boolean } | { blobsWithoutRow: string[], rowsWithoutBlob: string[], … } | – | – | no |
| `media.reconcileDelete` | Like media.reconcile, but always deletes the orphan blobs – the deletion is in the pipeline, not in the request | – | `result` | – | { blobsWithoutRow: string[], rowsWithoutBlob: string[], … } | – | – | no |
| `media.syncPublic` | Reconcile the public copies of every ready item's original with the stored items: fail abandoned uploads, finish interrupted deletes, write missing or mismatched copies, and remove copies of failed or deleted items and foreign files (adds _publicMedia: { written, removed, missing } to the result) | – | `result._publicMedia` | – | { _publicMedia: object, … } | – | – | no |
| `media.export:<arg>` | Copy every ready media item to <arg>/<folder>/<filename> | – | `result` | – | { written: number, skipped: number, missing: number, conflicts: number, … } | – | – | no |

Used by 14 of 102 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
