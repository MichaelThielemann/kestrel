# media/default
Uploads: one `POST /media` takes as many files as the HTTP trigger's `http.multipart.maxFiles`
allows (default 20; the h3 adapter's `multipart` option), a bulk upload sends several requests. Bytes go to `blobstore@1` under `<prefix><id>/<name>` — one blob key per item, fixed at
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
`media.list`, `media.download`, `media.serve` and `media.export:<dir>` (`NOT_FOUND` / filtered out
otherwise), `media@1` returns `ready` and `trashed` ones (see [Trash](#trash)), and a `failed` row is replaced when the same name is uploaded again, so a
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
`count`. A `ready` or `trashed` item is visible; `uploading`, `failed` and `removing` rows never are. A
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

## Trash

`media.trash` moves items to the trash instead of deleting them. The row gets `status: "trashed"`,
`trashedAt` and no `location`, so the item leaves the library at once: `media.get`, `media.list`
(search and `ids` included), `media.download`, `media.serve`, `media.export:<dir>`, the folder
counts and `media.listFolderItems` no longer see it, `media.update` answers 404, and another upload
may take its name in its folder. With `publicCopy`, its public copy is removed. Its key, blob,
`folder`, `filename`, texts and provenance stay.

For `media@1` a trashed item stays ready until it is purged: `file`, `files`, `load`, `scan` and
`count` still answer it, with its bytes. The contract's readiness ends before any of the stored
bytes go, and that happens at the purge; removing the public copy only changes what is published.
Modules that read media through `media@1` keep what they derived from it: `images-default` keeps the
variants of a trashed item across restarts and `images.syncPublic`, `references-default` counts a
reference to it as neither dangling nor broken, and `references.check` accepts a new reference to
it. Run `images.hideMany` after `media.trash` and `images.showMany` after `media.restore` to
withdraw the variants as well. A `media-default` that does not know `trashed` reads such rows as not
ready, and `images-default` then removes their variants at its next start; restore or purge the
trash before going back to one.

`media.restore` brings items back with the same id, key, `path`, folder, texts and provenance,
recreates their folder and writes their public copy again. When another item took the name
meanwhile, the restored one becomes `<stem>-<n>.<ext>` (the first free `n` from 2 on, cut to 200
bytes) and is listed in `renamed`; only the display name changes, never the `path`. A name held only
by a failed or abandoned upload is freed first, as an upload does, so it does not count as taken. A
restore that meets a folder rename of its item's folder restores the item into the renamed folder and
does not recreate the old one.
`media.trashFolder` trashes every ready item in a folder's subtree, deletes its failed uploads and
those abandoned for `uploadStaleAfterMs`, and removes the folder rows of that subtree. An upload still
under way keeps its row, so the folder stays listed until that upload ends. Items of the subtree that
are already in the trash are handed on in `ids` as well and named in `unchanged`, and a path whose
folder is gone but whose trashed items still carry it answers with those ids instead of 404, so
repeating the request after a later step failed reaches `images.hideMany` and the event for every
item again. `media.listTrash` lists the trashed items, most recently trashed first, with `trashedAt`,
`expiresAt` (`trashedAt` plus `trashRetentionDays`, default 30) and `path: null`; it takes `q`,
`limit`, `offset` and `locale` like `media.list`.

A purge is a selection followed by `media.purge`, so a step in between can narrow it: `media.selectTrash`
(the trashed ones among `body.ids`), `media.selectAllTrash` or `media.selectExpiredTrash` (trashed at
least `trashRetentionDays` ago) put ids into `result.ids`, `references.dropReferenced:media` leaves
the referenced ones in the trash, and `media.purge` deletes the rest for good, each as `media.remove`.
Without a selection before it, `media.purge` takes `body.ids`. An item restored between the
selection and the purge is never deleted. When a purge stops halfway (the blob store fails after the
item's readiness ended), repeating it finishes the delete: `media.selectTrash` and `media.purge` take
such an item like a trashed one, so it reaches `images.removeMany` and `media.deleted` as well.

`media.trash`, `media.restore`, `media.selectTrash` and `media.purge` with `body.ids` take 1 to 200
ids (`VALIDATION` otherwise) and answer per id with `{ ids, skipped: [{ id, reason }] }`, where
`reason` is `not_found`, `not_trashed` (`media.selectTrash`, `media.purge`) or `referenced` (added by
`references.dropReferenced`, kept by `media.purge`). For `media.selectTrash` and `media.purge`, `ids`
are the ids the step selected or deleted. For `media.trash` and `media.restore`, `ids` are every id
that is in the target state afterwards, trashed or ready, whether the step moved it or found it
there, and `unchanged` names those it found there; `media.restore` adds `renamed: [{ id, from, to
}]`. Both also answer `trashVersions`: per id in `ids`, the item's trash version (`trashVersion`), which
rises by one with every move into or out of the trash (`0` for an item never moved), so
`images.hideMany` and `images.showMany` can tell which of two overlapping moves came last.
`media.trashFolder` answers it as well. Repeating a step is safe, and it reaches every later step
again: when a trash or restore stops halfway, or a step after it fails, running the same pipeline
with the same ids hands every id on to
`images.hideMany` or `images.showMany` and the event, including the ones the first run already moved.
`media.trash` of a trashed item removes its copy again, and `media.restore` of a ready one writes its
copy again.

`media.remove` and `media.removeFolder` stay final deletes. `media.removeFolder` leaves the trashed
items of the folder in the trash, `media.renameFolder` moves them along (their `folder` only, without
taking a name), and `media.syncPublic` removes the copy of a trashed item, reading the item again
before and after it does, so an item restored during the sync keeps its copy. `media.trash` likewise
reads an item again after it removed its copy and writes the copy back when a restore came in
between. `media.update` and `media.renameFolder` write only to a row that is still live, so an item
trashed while they run keeps no name; `media.update` then answers 404. Nothing withdraws a copy a CDN or
browser cached under `public, max-age=31536000, immutable`, and a trashed file keeps its storage until
it is purged.

`examples/minimal` wires it like this, next to `DELETE /media/:id`:

```ts
triggers: [
  { http: "GET /media/trash", pipeline: "listMediaTrash" },
  { http: "POST /media/trash", pipeline: "trashMedia" },
  { http: "POST /media/trash/folders/*path", pipeline: "trashMediaFolder" },
  { http: "POST /media/trash/restore", pipeline: "restoreMedia" },
  { http: "POST /media/trash/purge", pipeline: "purgeMedia" },
  { http: "POST /media/trash/empty", pipeline: "emptyMediaTrash" },
  { cron: "0 4 * * *", pipeline: "purgeExpiredMedia" },
  { event: "media.trashed", pipeline: "mediaDependents" },
  { event: "media.restored", pipeline: "mediaDependents" },
],
```

```ts
const signedIn = ["authn.requireUser", "authz.requireRole"];
const purge = ["references.dropReferenced:media", "media.purge", "images.removeMany", "events.emit:media.deleted"];
definePipeline({ name: "trashMedia", steps: [...signedIn, "authz.require:media.delete", "media.trash", "images.hideMany", "events.emit:media.trashed", "events.relay"] });
definePipeline({ name: "trashMediaFolder", steps: [...signedIn, "authz.require:media.delete", "media.trashFolder", "images.hideMany", "events.emit:media.trashed", "events.relay"] });
definePipeline({ name: "restoreMedia", steps: [...signedIn, "authz.require:media.write", "media.restore", "images.showMany", "events.emit:media.restored", "events.relay"] });
definePipeline({ name: "listMediaTrash", steps: [...signedIn, "authz.require:media.write", "media.listTrash"] });
definePipeline({ name: "purgeMedia", steps: [...signedIn, "authz.require:media.delete", "media.selectTrash", ...purge, "events.relay"] });
definePipeline({ name: "emptyMediaTrash", steps: [...signedIn, "authz.require:media.delete", "media.selectAllTrash", ...purge, "events.relay"] });
definePipeline({ name: "purgeExpiredMedia", steps: ["media.selectExpiredTrash", ...purge] });
```

Moving an item that is still referenced to the trash is allowed (a page then renders without it
until it is restored); purging one is not. A deployment without a trash simply does not compose these
pipelines.

Config: `allowedTypes` (`image/*`, `application/pdf`, `*` or `*/*`), `deniedTypes` (default
`image/svg+xml`, `text/html`, `application/xhtml+xml` — they can carry scripts; both lists are
patterns matched against the media type without parameters, ignoring case, see above), `maxBytes`,
`prefix` (default `media/`, must end with `/`), `publicPath` (default `/media`), `publicCopy`
(optional `{ prefix }`), `uploadStaleAfterMs` (default 15 minutes), `anonymousList` (`"ids"` default,
or `"all"` for a public catalogue), `listPermission` (default `media.list`), `maxLimit` (default 200) and `defaultLimit` (default `maxLimit`, never
above it, or setup fails), `locales`/`defaultLocale`. `media.list` without `limit` answers at most
`defaultLimit` items with the full `total`, refuses a `limit` above `maxLimit` (400), and reads at most
`maxLimit` of the `ids` it is given. `trashRetentionDays` (default 30, a whole number of at least
1) is how long an item stays in the trash before `media.selectExpiredTrash` selects it.

## Anonymous reads

`media.get`, `media.serve` and `images.serve` answer an anonymous caller the same as a signed-in one
(a file's URL is meant to be public once a page links it). `media.list` and `media.listFolders` are
different: without a signed-in caller, `media.list` answers only when the request names `ids`
explicitly (401 `UNAUTHENTICATED` otherwise), and `media.listFolders` always needs a signed-in
caller. With an `authz@1` module loaded, a signed-in caller also needs `listPermission` (default
`media.list`) for either listing, or gets 403 `FORBIDDEN` — being signed in is not enough, so an account
whose roles grant nothing cannot see the whole library, unpublished uploads included; `media.*` grants
it. Set `anonymousList: "all"` to restore anonymous listing for a deployment that wants a public
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
`media.remove`, `media.reconcile`, `media.reconcileDelete`, `media.syncPublic`, `media.export:<dir>`,
and the trash steps `media.trash`, `media.trashFolder`, `media.restore`, `media.listTrash`,
`media.selectTrash`, `media.selectAllTrash`, `media.selectExpiredTrash` and `media.purge`.

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
| `media.list` | `VALIDATION` (invalid folder, unknown locale), `UNAUTHENTICATED` (no identity and no `ids`, unless `anonymousList: "all"`), `FORBIDDEN` (no `ids` and no `listPermission`) |
| `media.listFolders` | `UNAUTHENTICATED` (no identity, unless `anonymousList: "all"`), `FORBIDDEN` (no `listPermission`) |
| `media.update` | `VALIDATION` (name, folder, provenance or text), `NOT_FOUND`, `CONFLICT` (name taken in that folder) |
| `media.download`, `media.serve` | `NOT_FOUND` |
| `media.remove` | `VALIDATION` (missing id) |
| `media.createFolder` | `VALIDATION` |
| `media.renameFolder` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (target exists or is inside the source) |
| `media.listFolderItems` | `VALIDATION`, `NOT_FOUND`, `CONFLICT` (folder not empty and no `recursive`) |
| `media.removeFolder` | `VALIDATION`, `NOT_FOUND` |
| `media.trash`, `media.restore`, `media.selectTrash`, `media.purge` | `VALIDATION` (no ids, or more than 200) |
| `media.trashFolder` | `VALIDATION`, `NOT_FOUND` |
| `media.listTrash` | `VALIDATION` (unknown locale, limit above `maxLimit`) |
| `media.selectAllTrash`, `media.selectExpiredTrash` | – |
| `media.reconcile`, `media.reconcileDelete`, `media.syncPublic`, `media.export:<dir>` | – |

`media.reconcile` lists the blobs under `prefix` and compares them with the `media_items` keys:
`{ blobsWithoutRow, rowsWithoutBlob, legacyKeys }`. With `delete: true` it deletes the blobs nothing points at;
`media.reconcileDelete` is the same step with the deletion fixed in the pipeline instead of the
request, so a route can offer the report and the cleanup as two different endpoints;
rows are never deleted, because a row is the only record that a file was ever meant to exist. A key
is reported only when it has this module's own shape, `<prefix><id>/<name>` with exactly one segment
for each, and no item has that id at all. Anything else under `prefix` is never reported or deleted:
`images-default`'s variants whether its `prefix` lies under this one (`media/variants/` under
`media/`) or equals it (`media/<id>/thumb.webp` next to the original), a file directly under
`prefix`, a deeper key, or any file under the id of an item that exists. A row of an upload that is in flight right now shows up under `rowsWithoutBlob`, so run it
from a cron trigger rather than after every write; no trigger is wired here, that is the
consumer's job. `legacyKeys` lists the blobs of the 5.x layout that the conversion below recorded
in `media_legacy_keys`: they are reported apart from `blobsWithoutRow` and never deleted, also not
by `media.reconcileDelete`, so a backup taken before the conversion still finds every original it
names.

## Storage migrations

`@michaelthielemann/kestrel-media-default/storage` exports `storage(config)`, the module's storage
for `helpers/shape-migrations` of `kestrel-contracts`, and `migrations`. Its one migration,
`media-default:id-key-layout` (introduced in 6.0.0), converts the items a 5.x release stored under
`<prefix><folder>/<filename>`:

- the item's name is `nameFor(filename, contentType)`, the name an upload of the same file gets;
  when its folder already holds that name, the first free `<stem>-<n>.<ext>`;
- the original is copied to `<prefix><id>/<name>`, and the copy's size and sha256 are checked
  against the original before the item switches to it;
- `location` is filled in, so each name is unique within its folder;
- the old blob stays, and its key is recorded in `media_legacy_keys` together with every other 5.x
  key found under `prefix`;
- an item whose original is missing keeps its row and is reported; with the answer `trash` to the
  question `media-default:id-key-layout:missing-original` it is moved to the trash instead.

The migration writes blobs, so it never runs when the module starts. It runs offline on a copy of
the data (`kestrel upgrade migrate --db <file> --blobs-dir <dir>`) or as part of `kestrel update`.
It works through the items in chunks and each item on its own, so a run that stops halfway is
finished by running it again, and a second run changes nothing. Afterwards the module's row in
`kestrel_storage_versions` says `6.0.0`.

`storageMigrations` (default `check`) decides what setup does with data in an older storage shape:
`check` refuses to start and names the migration and the command that runs it; `apply` runs the
migrations that write no blobs and still refuses one that does, which for this module is every
migration. Data whose version row names a newer release, or one older than the module converts, is
refused either way.

## Behaviour

Filenames are capped at 200 bytes, and only after truncation checked for a trailing `.meta.json`,
which is rewritten to `-meta.json`; this order means truncating a filename can never accidentally
produce the internal metadata-sidecar suffix.

`media.list`'s `q` is a substring match on the filename that ignores case, and so is
`media.listTrash`'s; `_` and `%` in it match themselves.

`media.update` validates the whole patch, text fields included, before touching the row; it never
calls the blobstore, since neither a rename nor a move ever changes a key.

Setup also fails on start if a stored item's key is not `<prefix><id>/<name>`, naming the first such
item, the count of items affected and the migration that converts them.

Not included: image resizing, tags, linking media to content documents.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-media-default` – module `media/default`: provides `media@1`; requires `blobstore@1`, `persistence@1`; optional `authz@1`.

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
| `maxLimit` | integer | no | `200` |
| `defaultLimit` | integer | no | – |
| `listPermission` | string | no | `"media.list"` |
| `trashRetentionDays` | integer | no | `30` |
| `storageMigrations` | enum | no | `"check"` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `media.upload` | Upload one or more files (multipart field `file`, repeatable). A single file returns the item; multiple files return per-file results. Idempotent: same folder, same filename and same bytes return the item that is already there, and the step then ends the pipeline itself (200), so no following step – notably events.emit:media.uploaded – runs for an upload that stored nothing | `files` | `result` | { folder?: string, provenance?: string } | object \| object (ends: object \| object) | 400 no file or invalid folder/provenance (per-file for a multi-file request); 409 the folder already has a file with that name, `details.field: "location"` (per-file for a multi-file request); the same bytes again are idempotent, not a conflict; 413 file exceeds maxBytes (per-file for a multi-file request); 415 type not allowed (per-file for a multi-file request) | – | no |
| `media.update` | Rename, move, set provenance or texts (alt/title/description per locale); the file's key and path never change | `params.id` | `result` | { filename?: string, folder?: string, provenance?: object, locale?: string, alt?: string \| null, title?: string \| null, description?: string \| null } ?locale: string | { id: string, path: string, filename: string, folder: string, contentType: string, size: number, createdAt: number, updatedAt: number, provenance: object, width: number \| null, height: number \| null, alt: string \| null, title: string \| null, description: string \| null } | 400 invalid name, folder or text (texts are plain text, max 2000 chars); 404 not found; 409 the folder already has a file with that name, `details.field: "location"` | – | no |
| `media.get` | Media metadata | `params.id` | `result` | ?locale: string | { id: string, path: string, filename: string, folder: string, contentType: string, size: number, createdAt: number, updatedAt: number, provenance: object, width: number \| null, height: number \| null, alt: string \| null, title: string \| null, description: string \| null } | 400 unknown locale; 404 not found | – | no |
| `media.list` | List media, newest first; anonymous callers may only fetch by ids | `identity?` | `result` | ?folder: string, recursive: boolean, q: string, sort: string, type: "image" \| "video" \| "other", limit: integer, offset: integer, ids: string, locale: string | { items: object[], total: number, … } | 400 invalid folder, unknown locale, invalid type, or limit above maxLimit; 401 no identity and no ids (unless anonymousList is "all"); 403 no ids and, with an authz module, no listPermission | – | no |
| `media.listFolders` | Folders (persistent and implied) with item counts; anonymous callers are refused | `identity?` | `result` | – | object[] | 401 no identity (unless anonymousList is "all"); 403 with an authz module, no listPermission | – | no |
| `media.createFolder` | Create a folder (idempotent: an existing folder is returned unchanged) | – | `result` | { path: string } | { folder: string, count: number, … } | 400 missing or invalid path | – | no |
| `media.renameFolder` | Rename or move a folder (metadata only: keys and paths do not change) | `params.path` | `result` | { path: string } | { folder: string, moved: number, … } | 400 missing or invalid path; 404 folder not found; 409 target folder already exists | – | no |
| `media.listFolderItems` | Item ids in a folder, for use with references.guardAll:media before removeFolder | `params.path` | `result` | ?recursive: boolean | { path: string, ids: string[], … } | 400 missing or invalid path; 404 folder not found; 409 folder not empty (without `recursive`) | – | no |
| `media.removeFolder` | Delete a folder and everything in it (each item as media.remove) | `params.path` | `result` | – | { ok: boolean, removed: number, ids: string[], … } | 400 invalid path; 404 folder not found; 409 folder not empty or still referenced | – | no |
| `media.download` | The file itself | `params.id` | `result` | – | – | 404 not found | – | no |
| `media.serve` | The file at its public URL (params.id, params.name); the name must be the one it was uploaded under | `params.id`, `params.name` | `result` | – | – | 404 not found, not ready, or not the name the file was uploaded under | – | no |
| `media.remove` | Delete file and metadata: end the item's readiness, then remove copy, blob and row, then a final sweep | `params.id` | `result` | – | { ok: boolean, … } | 400 missing id | – | no |
| `media.trash` | Move the items in body.ids to the trash: the library no longer shows them, their names are free and their public copies are removed, while media@1 still reads them as ready until media.purge; per-id answer: result.ids holds every id that is trashed afterwards, an already trashed one also in result.unchanged (its public copy is removed again), an unknown one is skipped | – | `result` | { ids: string[] } | { ids: string[], unchanged: string[], skipped: object[], trashVersions: object, … } | 400 no ids or more than 200 | – | no |
| `media.trashFolder` | Move every ready item in a folder's subtree to the trash, delete its failed and abandoned uploads, and drop the folder rows of that subtree; an upload still under way keeps its folder listed; media.restore recreates the folders of the items it restores; result.ids also holds the items of the subtree already in the trash, named in result.unchanged, so a repeated request reaches them again after the folder is gone | `params.path` | `result` | – | { path: string, ids: string[], unchanged: string[], trashVersions: object, … } | 400 missing or invalid path; 404 neither a folder nor a trashed item at this path | – | no |
| `media.restore` | Bring the trashed items in body.ids back with the same id, key, path, folder and texts; a display name taken meanwhile becomes <stem>-<n>.<ext> (listed in renamed); per-id answer: result.ids holds every id that is ready afterwards, an already ready one also in result.unchanged (its public copy is ensured), an unknown one is skipped | – | `result` | { ids: string[] } | { ids: string[], unchanged: string[], skipped: object[], trashVersions: object, renamed: object[], … } | 400 no ids or more than 200 | – | no |
| `media.listTrash` | The trashed items, most recently trashed first, with trashedAt and expiresAt and no public path | – | `result` | ?q: string, limit: integer, offset: integer, locale: string | { items: object[], total: number, … } | 400 unknown locale or limit above maxLimit | – | no |
| `media.selectTrash` | Select the trashed items among body.ids, and those whose purge stopped halfway, into result.ids for media.purge, reporting the others in result.skipped | – | `result` | { ids: string[] } | { ids: string[], skipped: object[], … } | 400 no ids or more than 200 | – | no |
| `media.selectAllTrash` | Select every trashed item into result.ids for media.purge | – | `result` | – | { ids: string[], skipped: object[], … } | – | – | no |
| `media.selectExpiredTrash` | Select the trashed items whose trashRetentionDays have run out into result.ids for media.purge | – | `result` | – | { ids: string[], skipped: object[], … } | – | – | no |
| `media.purge` | Delete trashed items for good, each as media.remove: the ids in result.ids when an earlier step selected them (its result.skipped is kept), otherwise body.ids (at most 200); an item whose purge stopped halfway is finished, any other id that is not trashed is skipped | `result.ids?`, `result.skipped?` | `result` | { ids?: string[] } | { ids: string[], skipped: object[], … } | 400 no ids selected and no body.ids, or more than 200 body.ids | – | no |
| `media.reconcile` | Compare the blobs under the media prefix with the media_items rows; with `delete` also removes blobs that no row points at (rows are never deleted, nor the 5.x-layout blobs listed in legacyKeys) | – | `result` | { delete?: boolean } | { blobsWithoutRow: string[], rowsWithoutBlob: string[], legacyKeys: string[], … } | – | – | no |
| `media.reconcileDelete` | Like media.reconcile, but always deletes the orphan blobs – the deletion is in the pipeline, not in the request | – | `result` | – | { blobsWithoutRow: string[], rowsWithoutBlob: string[], legacyKeys: string[], … } | – | – | no |
| `media.syncPublic` | Reconcile the public copies of every ready item's original with the stored items: fail abandoned uploads, finish interrupted deletes, write missing or mismatched copies, and remove copies of failed, trashed or deleted items and foreign files, re-reading an item before its copy goes (adds _publicMedia: { written, removed, missing } to the result) | – | `result._publicMedia` | – | { _publicMedia: object, … } | – | – | no |
| `media.export:<arg>` | Copy every ready media item to <arg>/<folder>/<filename> | – | `result` | – | { written: number, skipped: number, missing: number, conflicts: number, … } | – | – | no |

Used by 22 of 111 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
