# images/default
One variant per effective size for every eligible image a `media@1` provider — `media-default` —
reports as ready, at its own public URL before it is ever rendered: placed on upload, rendered in the background or inline depending on the
event delivery mode, completed/repaired by a resumable sync job, listed on media metadata, served by
path, exportable, pruned or retired only on explicit request. The original is never touched.
Effective sizes = config/default sizes merged with `images.register`ed ones (a name colliding with a
config size is `CONFLICT`). The default sizes render WebP; a size may set `format: "original"` to
keep the source format (JPEG for a type sharp cannot re-encode as itself, e.g. HEIC or TIFF).

## Reading media through `media@1`

This module requires `media@1` (`@michaelthielemann/kestrel-contracts/media`) and reads media only
through it: whether an item exists and is ready, its type, the type the provider publishes it with,
its size, stored dimensions, folder and display name, and its bytes. It never reads another module's
collection or a storage key of the original. The module's setup wraps the `persistence@1` handle
with `ownedPersistence` before `createImages` ever sees it, so the only handle the implementation
holds reaches `images_sizes`, `images_variants`, `images_jobs`, `images_retired`, `images_hidden`, `images_framing` and `images_items` (`COLLECTIONS`),
and any other collection is a wiring error that names this module. Boot fails when no active module provides `media@1`
(`missing-provider`), and a config that still sets the removed `media` option fails its schema.

Readiness is the provider's: an item is live exactly while `file(id)` answers it. When attached, this
module removes the rows, private variants and public copies of every item that has rows here but is
no longer ready (a delete whose `images.remove` never ran, for example after it failed midway), so
such leftovers disappear with the next start in every deployment. The sweep runs in the background
and stops between chunks of 200 items once the module is closed, so a shutdown never waits for it;
the next start picks up what is left. An item that is
not ready — still uploading, failed, or being deleted — is never planned, rendered, served,
exported or counted, and `images.generate` or `images.retryFailed` with its id answers `NOT_FOUND`.
Which types get variants is one rule, `ELIGIBLE` in `generate.ts`: `image/*` except `image/gif` and
`image/*+xml` (SVG and every other XML image type, which a browser would open as a document that can
run script). The module evaluates it with `mediaTypeAllowed` and hands the same filter to the
provider's `scan` and `count`, so both always agree.

## Paths exist before rendering

A size's path, dimensions and format are decided from the *original* — never from the render — the
moment the item is placed: `plannedDimensions` computes the exact width/height an `inside` or
`cover` fit will produce from the oriented original (after EXIF rotation), and the format follows
the size's own `format` (`webp`, or the type's native format for `original`). This is why a variant's
`width`/`height` are already meaningful before any render ran, and why the render always produces
exactly the planned pixels — the client never guesses them.

Placing and rendering are two different pieces of work. New step `images.plan` places every
effective size of one item: it creates the variant row (state `planned`) and, with `publicCopy`
configured, writes the original's own bytes to the variant's public path — only once that write
lands does the row turn `pending` and the item count as available. `images.generate` does the
rendering: it replaces the placeholder (or, in the direct event-delivery mode, renders straight into
the path without ever writing a placeholder first) and turns the row `done`. With a queuing event
delivery module, an upload's placing runs in its own short pipeline (`images.plan`, then
`events.emit:images.planned`) so an item becomes usable without waiting for a render; rendering
subscribes to `images.planned` and can run in its own lane. With inline event delivery,
`images.generate` alone does both in the upload request, and a size it could not render there is
left `planned` and placed and rendered by this module's own background loop right after the request —
never inside it. An original is handed to sharp only when its leading bytes identify it as the media type it is
stored with (`contentMatchesMediaType`), so a file of another format, SVG among them, never reaches a
decoder through a raster type; such an original counts as one sharp cannot decode, and a row whose
original changed its content fails its attempt with `the original's content does not match its media
type <type>`. An image sharp cannot decode gets its rows too (dimensions from the media item, error
`cannot decode`): they stay `planned` until the original's bytes are at every path, and turn
`failed` only then, so such an item becomes available like any other and never lists a path without
a file.

Sizes are declared in code, so none of them are stored: config sizes come from the config on every
boot and registered sizes live in the process that took them, rebuilt by every `images.register`
call. A host that registers sizes must therefore register them at boot — until it does,
`images.listSizes` and `images.serve` only know the config/default sizes, and `images.readStatus`
reports nothing as orphaned (`registrySeen: false`) because it cannot yet tell a leftover from a
size that has not been registered again yet. Size rows written by earlier versions are deleted once
at setup, with a log line naming the count; a variant or retired row without a `slot` (written before
6.0.0) stops setup instead, since this version cannot read it. Whenever the effective size set changes — a new size, or
an existing one with a new width/height/fit/format/quality — this module compares it against the
stored rows and starts its background sync job to place and render the difference on every existing
item, raising `images.variantsChanged` (see below) per chunk it touches. The comparison counts the ready items
`media@1` reports as eligible (`count(ELIGIBLE)`) against the rows of each size, so an image that has
no rows yet — its plan is still queued, or its provider has lost its bytes — also starts that job at
every start until it is placed or deleted; the job then skips it after logging why. The job pages
through `scan(ELIGIBLE)` with the provider's cursor, so a job paused by another process resumes where
it stopped, and its `total`, `done` and `failed` count those eligible ready items only. `images_variants` is otherwise
unaffected by a size change alone: variants stay in the database, and `images.readStatus` reports
variants of sizes nobody declares any more under `orphaned`, which `images.prune` retires (see
below).

Config: `sizes` (defaults `thumb 320, small 640, medium 1024, large 1600, xl 2400`, all
`inside`/`webp`/82), `prefix`, `publicPath` (default `/media`), `publicCopy` (optional `{ prefix }`),
`chunk`, `staleAfterMs`, `maxAttempts` (default 5), `renderTimeoutMs` (default 30000, and below
`staleAfterMs`, or the config fails its schema).
Steps: `images.register` (`VALIDATION` on an empty or malformed list, `CONFLICT` on a config
collision), `images.listSizes`, `images.plan` (id from params/payload/event; places without
rendering), `images.generate` (id from params/payload/event; `VALIDATION` without an id, `NOT_FOUND`
for an id `media@1` does not report as ready), `images.sync` (`CONFLICT` while a fresh job runs), `images.resume` (cron: also
places and renders any item whose lease ran out, with a request left open for longer than
`staleAfterMs`, with a row that already had a render at its path and was left `pending` for longer
than `staleAfterMs`, with a row left `planned` or in `error` for longer than `staleAfterMs`, with a
row of a declared size planned with another spec than the size now has and untouched for longer than
`staleAfterMs` while no sync job runs, and any recent item with no rows at all; `CONFLICT` once `close()` has begun), `images.retryFailed`
(`NOT_FOUND` for an id `media@1` does not report as ready), `images.prune` (`VALIDATION` for a name that is still declared or
has no variants; retires rather than deletes the path), `images.readStatus`, `images.remove`
(`VALIDATION` without an id), `images.removeMany` (after `media.listFolderItems` or
`media.removeFolder`, reads `result.ids`), `images.setFraming` (see "Focus and crop"),
`images.attach` (adds `available`, `variants[]`, `variantCounts`, `focus` and `framing` to `result`;
each `variants[]` entry is `{ size, width, height, format, bytes, state, path, crop }`, where `crop`
names the part of the original its bytes show, see "Focus and crop"), `images.serve` (binary; `VALIDATION` without id/file, `NOT_FOUND`
otherwise), `images.syncPublic` (reconciles the public copy tree), `images.export:<dir>` (nests its
counts under their own key in `result`, so running it after `media.export` in one pipeline keeps
that step's counts). Every step passes a persistence or blobstore failure through unchanged, so a
busy database is a retryable `TRANSIENT` (503).

## Public copies

With `publicCopy: { prefix }` configured, every variant's public path also gets a copy at
`<publicCopy.prefix><publicPath without its leading "/">/<id>/variants/<size>.<ext>` (e.g.
`site/media/<id>/variants/thumb.webp`) — the original's bytes until the render replaces them at the
same path, so a static export or a bucket whose `site/*` is served directly always has *something* at every listed
path, never a 404. `images.syncPublic` reconciles that tree: it removes copies (and rows) of items
that are gone, places a ready item missing a size, rewrites a copy that does not match its row, and
removes a foreign file — all restricted to files directly under `<id>/variants/`, never anything
this module did not put there — and starts the sync job when a row still waits for its render. It
decides that an item is gone, or that a file has no owner, by reading that item's rows right before
it removes anything, never from a list it read earlier; it pages through rows by id, so rows it
removes on the way never make it skip others; and after writing a copy it reads the owner again and
removes the copy when the item was deleted meanwhile. Serve the copy tree with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, as
the Node origin does; a placeholder holds the original's bytes under the variant's extension until the
render replaces it. A render's copy takes its `Content-Type` from `publicFormOf` in
`@michaelthielemann/kestrel-contracts/helpers/mediaType`; a placeholder, a retired path and `images.serve`'s
fallback carry the original's `publishedType` from `media@1`, the type its provider serves the
original with itself (`media-default` sends `application/octet-stream` for a name stored as `.bin`),
so the same bytes never reach two paths with two types. The variant URL shares the item's public
directory with the original's: configure `publicPath` and `publicCopy` exactly as on
`media-default`, and give this module a `prefix` other than `media-default`'s (it may lie under it,
such as `media/variants/` under `media/`). Boot fails if the copy tree overlaps this module's own storage
`prefix`, if `publicCopy` is set but no pipeline runs `images.serve`, or if a pipeline runs
`images.syncPublic` without `publicCopy` set.

## Retired paths

A path, once listed, keeps answering until the item itself is deleted — even after the size behind
it stops existing. A format change (`webp` ↔ `original`, or one `original` type to another) retires
the *old* path: a record in `images_retired` remembers it, its copy is overwritten with the
original's bytes, and the size's own row moves to its *new* path and is placed and rendered there.
`images_variants.slot` (`<mediaId>/<size>`) is unique, so an item never has two rows for one size;
changing the format back makes the old file current again instead of keeping it retired. `images.prune` does the same for a
size that is no longer declared at all: retire, delete the variant row, overwrite the copy with the
original and delete the private blob — the path stays, `images.prune`'s `{ sizes, variants }` counts what
it touched. When one of the last two steps fails for an item, the size has already left that item's
`variants[]`: `images.prune` raises `images.variantsChanged` for the items it reached, and a retry
goes on with the items it did not reach and answers `VALIDATION` once no row of the size is left.
`images.syncPublic` puts the item whose step failed right: it overwrites the copy and deletes the
private blob. Without public copies, such a private blob stays until the item is deleted. `images.serve` and the content rule below treat a retired file exactly like a variant row
that never got its render: always the original's bytes and type. This is what lets a page published
before a size or format changed keep working without a republish; only `images.attach`'s own
`variants[]` stops listing the retired path for pages rendered afterwards.

## Hidden items

`images.hideMany` hides the variants of every id in `result.ids`, typically right after
`media.trash` or `media.trashFolder`: its row in `images_hidden` marks it hidden, and its public copies
under `<id>/variants/` — current sizes and retired paths alike — are removed. Until
`images.showMany` (after `media.restore`) lifts the mark, `images.serve` answers 404 for each of its
paths, `images.export:<dir>` leaves its variants out, `images.attach` lists no variants for it and
reports it as not `available`, and nothing writes a public copy for it again: not the placeholder of
a new size, not the end of a render, not a retired path, not `images.syncPublic`, which also removes
any copy of it that it finds. Both steps leave a request on the item's lease (see "Focus and crop")
before they set or lift the mark, so a hide whose copies were not all removed, or a show whose copies
were not all written, is finished by `images.resume` once `staleAfterMs` has passed. A request
another call left there is kept, and the step that takes the item places and renders it again before
it lets go. Every writer of a public copy checks the mark before and after it
writes, so a copy written while a hide in another process lands is withdrawn again, and written once
more when a show followed before the withdrawal. Its rows, its
private variants and its renders stay and go on as
usual, so `images.showMany` only writes the copies again, from the stored renders or, where none is
done yet and for a retired path, from the original. A media trash keeps the item ready for
`media@1`, so its variants survive restarts and `images.syncPublic` either way; the hidden mark is
what keeps them off the public paths. The mark goes with the item's variants when it is deleted, and
the start sweeps it away for an item `media@1` no longer has. An id `media@1` does not know is not
marked.

When a trash and a restore of the same item run at the same time, their `images.hideMany` and
`images.showMany` can arrive in the other order than the moves they follow. Both steps therefore also
read `result.trashVersions`, which `media.trash`, `media.trashFolder` and `media.restore` write: the
item's trash version, which rises with every move into or out of the trash. The row in
`images_hidden` keeps the version of the last hide or show, also after a show, and a hide or show
with a lower version leaves the item as it is. So the move that happened last decides, and the
variants end up hidden exactly when the item ended up in the trash. Without `result.trashVersions` (or
through `Images.hide` and `Images.show` without `versions`), each call applies as it comes. An entry
that is not a whole number of at least zero counts as missing.

Both steps read `result.ids`, leave the result as it is, raise no `images.variantsChanged` (the
`media.trashed` and `media.restored` events already mark the pages that show the item) and can run
again without harm. Hiding waits for a placement or render of the item that is under way in this
process; a crash between `media.trash` and `images.hideMany` leaves the variants public until the
pipeline runs again with the same ids. That works because `media.trash` and `media.restore` put an
id that is already trashed or ready into `result.ids` too. Nothing finds such an item on its own,
since `media@1` reports it as ready.

## Focus and crop

A media item can carry a *framing*: one focus rectangle and, optionally, a manual crop per aspect
ratio. Every rectangle is `{ x, y, w, h }`, normalised to 0..1 on the original as it is displayed,
after its EXIF orientation: a portrait photo taken with a phone held upright uses its upright
dimensions (in a browser, the image's `naturalWidth` and `naturalHeight`). `x`/`y` is the top-left
corner; a focus with `w` and `h` of 0 is a point.

A framing applies to `cover` sizes only. An `inside` size keeps the whole image and is never
rendered again because of a framing; the default sizes are all `inside`, so without a `cover` size the
focus is data for the page, for example for a CSS `object-position`. Each `cover` size has a ratio
key: its width and height reduced by their greatest common divisor, so `1600x900` and `800x450` are
both `"16:9"`. The key is exact: `1000x562` is `"500:281"`, a key of its own, although its ratio is
nearly 16:9. A manual crop is stored per key and applies to every `cover` size of that ratio. A crop
for a key that no `cover` size has stays stored and applies once such a size exists.

The crop a ratio renders with is, in this order:

- the manual crop for its key, brought to the exact ratio around its centre with the same area and
  shifted back inside the image;
- otherwise, with a focus, the largest rectangle of the ratio centred on the focus's centre and
  shifted back inside the image, so a focus at an edge or in a corner moves the cut, not out of it;
- otherwise the centre, exactly as without a framing.

A crop whose left, top, right and bottom edges each lie within one pixel of the centred one counts
as the centre, whether it comes from the focus or from a manual crop (`ratios[].manual` still says a
manual crop is stored): it renders as the centred cut and is listed `null`. From a 1920 × 1281
original, the 3:2 cut of a focus at the top edge, `{ left: 0, top: 0, width: 1920, height: 1280 }`,
is a pixel off the centred cut, which starts at `top: 1`, so it is the centre. A variant already cut from the centre does not render
again and its path stays as it is, while one cut elsewhere renders again from the centre and gets a
new `?v=` like any other change of its cut. A focus larger than the ratio allows cannot fit: the cut is still
centred on it, and `fits` (below) is `false`. A crop is never enlarged: a size larger than its crop
renders at the size's ratio and no larger than the crop, so its `width`/`height` in `variants[]`
shrink and several sizes of one ratio can end up with the same dimensions.

`images.setFraming` replaces the framing of the item in `params.id` with the payload
`{ focus?, crops? }`. A field left out is empty, so `{}` or `{ focus: null }` without crops removes
the framing. It answers `VALIDATION` for an unknown field, a value outside 0..1, a rectangle that
reaches past the image, a crop without width or height, a key that is not reduced (`"32:18"`), more
than 64 crops, or a crop whose pixel ratio on the oriented original differs from its key by more
than 2%; and `NOT_FOUND` for an id `media@1` does not report as ready, an item that is not an image
with variants (see `ELIGIBLE`) and a hidden item. It answers `{ id, framing }`. The write and the
re-planning of the item run in the item's own section, after a placement or render of the item
already under way in this process. When the focus differs from the stored one, it raises
`images.variantsChanged` for the item at once, since pages read `focus` from `images.attach` even
when no variant renders again (with `inside` sizes only, or when every cut stays the same).
Re-planning turns every `cover` size whose crop changes `pending` at the same path, with its new
width and height, and leaves the old variant there; a pipeline renders them by running
`images.generate` after it, as `setMediaFraming` in `examples/minimal` does. A size added later is
placed with the item's framing. When re-planning fails after the framing was stored,
`images.setFraming` answers the error and plans and renders the item again in the background.

Until the new render is at the path, the origin and the public copy serve the old variant, never the
original's bytes. Once it is there, `variants[].path` ends in a new `?v=<token>`, and
`images.variantsChanged` is raised for the item, so pages that show it render again with the new
URL. The token is a short hash of the variant's row and a count kept with it (`renders`), which a
render raises in the same conditional update that marks the row `done` or records a failed attempt
whose bytes stayed at the path, and which `images.syncPublic` raises when it rewrites a public copy
of another byte size or finds other bytes at the variant's key than its row records. So the query changes only once new bytes are at the
path, and it never comes back for that path: a crop
set back to an earlier one, or a framing reset to the centre, gets a URL of its own, and a URL
that a cache filled stays bound to the bytes it got then. The same holds for any later render at
the path, after a changed size or format, a repair by `images.resume`, or a size registered again
after a prune, whose path held bytes before. The query appears from a row's second finished render
on, or once `images.syncPublic` rewrote its public copy of another byte size, and a row placed at a path that held bytes before starts its count at one. A format change
moves the row to another path and keeps its count, one more when that path held bytes before (a
change back to the row's earlier format, for example), so the first render at the new path of a
variant that rendered before already has a query, and a URL listed while it renders is not one the
path had before. Only a row's first render, at a path that never
held other bytes, keeps the plain path. The path itself, the public copy's file name, `images.serve` (whose
`:file` carries no query) and `images.export:<dir>` stay as they are; a check that compares
exported URLs with files ignores the query.

Placing, rendering and writing the public copies of one item happen under a lease on the item, a row
per media id in `images_items` that one process holds at a time for `staleAfterMs` and renews before
each write of a path; `renderTimeoutMs` is below `staleAfterMs`, so a render ends before the lease it
renews runs out. `images.plan`, `images.generate`, `images.setFraming`, `images.hideMany`,
`images.showMany`, `images.syncPublic` and `images.resume` take it; a call that finds the item held by
another process does what needs no lease (`images.setFraming` stores the framing and raises the focus
event, `images.generate` answers the rows as they are, `images.hideMany` removes the public copies),
leaves a request on the lease and returns. The holder sees the request before it lets go and places
and renders the item again with what is stored then, writing its public copies as well (or removing
them while the item is hidden); a holder that only places (`images.plan`, `images.setFraming`) leaves
this to its background loop. A request left after the holder let go waits for `images.resume`, which
serves it once `staleAfterMs` has passed; `images.showMany` takes the item itself in that case and
places, renders and writes its public copies before it returns. An `images.setFraming` that stored
its framing but could not leave its request places and renders the item in its background loop. A
render that sees a request before it writes drops its bytes and renders again, so two framings saved
at once in two processes leave the rows on the framing that is stored. A render marks its row `done`
with the crop it rendered after its bytes are at the path, so a row's `?v=` changes only once bytes
rendered with its crop are there.

A holder that stops (the process ends) leaves its lease until `staleAfterMs` has passed;
`images.resume` then takes it over and places and renders the item, and until that render is done the
URL under the row's current `?v=` may answer the bytes the stopped holder left. A holder that stalls
longer than `staleAfterMs` stops before its next write once another process has taken the item over.
It changes a variant row only while the row is still as it read it, so it never re-plans a row,
records a failed attempt or marks a row `done` over what the new holder wrote. A single write of a
path that stalls that long can still land after the new holder's; the stalled holder notices when
it has finished its writes (after a failed public copy, once it put the earlier bytes back), marks
the item, and every size of the item that is `done`, `error` or `failed` renders again, except the
sizes of an original that cannot be decoded, which stay `failed` with `cannot decode`. Until then
that path answers the stalled bytes, and a cache that fetched it meanwhile keeps them under the
current `?v=`; the render after it gives the path a new `?v=` and raises `images.variantsChanged`.

A page published before a re-render goes on asking for its URL (the plain path or an earlier `?v=`)
until it is published again after `images.variantsChanged`, while the path already answers the new
render, so a cache that fetches that URL meanwhile stores the new bytes under it. No later render
at the path is given that URL again, so a page published afterwards never meets other bytes under
it, also when a crop is set back or the framing is reset.

`images.attach` adds `focus` (the rectangle or `null`), meant for anonymous readers, and
`framing: { focus, crops, width, height, ratios }`, meant for an editor. `width` and `height` are the
original's dimensions after its EXIF orientation, which every rectangle and pixel crop refers to, or
`null` while the item is not planned yet or cannot be decoded. `ratios` has one entry per ratio key of the
effective `cover` sizes: `{ key, sizes, manual, fits, crop }`, with the names of its sizes, whether a
manual crop is stored for it, whether the focus lies within its cut (`true` without a focus), and the
pixel crop it renders with on the oriented original, `{ left, top, width, height }` or `null` for the
centre, up to a pixel per edge. An item without variants gets `focus: null` and an empty framing with `width` and `height`
`null` and no ratios.

A framing outlives the trash: the item is hidden, not gone, so trash and restore keep it unchanged,
and a render of a hidden item writes no public copy. `images.remove`, `images.removeMany` and the
start's sweep of items `media@1` no longer has delete it with the variants. The framing is stored in
`images_framing`, one row per media id; `images_variants` keeps the crop of each row and the crop of
its last finished render as `"left,top,width,height"`, where an empty or missing value is the
centre, and in `renders` the count its `?v=` token is made from.

The crop rules live in `@michaelthielemann/kestrel-images-default/framing`, a subpath that imports
nothing, so an editor that runs in the browser can preview exactly what this module renders:
`ratioKey`, `centredCrop`, `cropForRatio`, `effectiveCrop`, `focusFits`, `parseFraming`,
`formatCrop` and `parseCrop`, with the types `Rect`, `Framing`, `PixelCrop`,
`FramingSize` and `FramingParse` and the constants `EMPTY_FRAMING`, `CROP_RATIO_TOLERANCE` and
`MAX_CROPS`. This module uses the same functions. They take the oriented dimensions of the original,
which `framing.width` and `framing.height` carry; `media@1`'s stored `width`/`height` are not
oriented and give a wrong cut for a rotated photo.

### Which variants show the same picture

Each entry of `variants[]` carries `crop`, the part of the oriented original that the bytes at its
`path` show: `{ left, top, width, height }` in pixels, in the form of `framing.ratios[].crop`. It is
`null` when they show the whole image (an `inside` size) or the centred cut of the size's ratio, up
to a pixel per edge. For a `cover` size whose ratio equals the original's, the centred cut is the
whole image, so its entries are `null` like the `inside` ones unless a manual crop applies. `crop`
is taken from the last finished render at the path, not from the planned one: a size that renders
again after a framing change keeps its old `crop` and its old `?v=` until the render that marks it
`done` changes both. A path without a finished render lists `null`, and so does a row whose
rendered crop is missing or does not parse.

Two `done` entries with the same aspect ratio and an equal `crop` show the same picture at
different resolutions, and a `srcset` should combine only such entries: one that mixes crops shows
a different picture depending on the viewport and pixel density, and one that leaves out an
interchangeable entry looks blurry on high-density screens. `width` and `height` are whole pixels,
so two entries have the same aspect ratio when their ranges from `(width - 0.5) / (height + 0.5)`
to `(width + 0.5) / (height - 0.5)` overlap or touch, as for 1000 × 563 and 320 × 180, both 16:9. The
test is approximate: two entries that pass it can show cuts that differ by a few pixels at the
smaller entry's resolution, about two pixels per side for a wide one. From a 2000 × 800 original,
an `inside` 799 × 320 of the whole image and a `cover` 798 × 321 of its centred cut, 1989 pixels
wide, both pass it with `crop` `null`.

#### When the listing and the bytes differ

- A `pending` entry around its render: before it, the path still answers the previous render,
  listed with the dimensions planned for the next one; just before the row is marked `done`, the
  path already answers the new bytes under the old `crop` and `?v=`.
- A path without a finished render (after an upload, for a size added to the configuration or
  registered again after a prune, after a format change) answers the original's bytes and lists
  `crop` `null`.
- After a storage fault or an instance that stalled past `staleAfterMs`, an entry, `done` ones
  included, can list another `crop` or `?v=` than the bytes its path or its public copy answers,
  until the item renders again or `images.syncPublic` writes its public copies. `images.syncPublic`
  gives the path a new `?v=` when it rewrites a public copy of another byte size. A copy put right
  by another write before `images.syncPublic` lists the public copies, or rewritten at an unchanged
  size, keeps its `?v=`, so a cache that fetched it meanwhile keeps the earlier bytes until the item
  renders again; one put right while it lists gets one more `?v=`.
- After the database is restored from a backup older than the stored variants, an entry lists the
  `crop` and `?v=` of its restored row, while its path may answer a later render, until the item
  renders again. `images.syncPublic` sets an entry pending and renders it again when its key holds
  bytes of another size than its row records, or none; without public copies, a change of the
  item's framing or of the size does. The pending entry lists its next `?v=` at once, which can be
  one handed out after the backup, and any `?v=` handed out after the backup can come back once the
  item rendered more than once since.

`state` tells the `done` entries apart. Anonymous callers do not receive it with the grants of
`examples/minimal` or the grant `kestrel upgrade` proposes, so a page built from such a read cannot
apply the rule on its own. Published pages are rebuilt on `images.variantsChanged`, which is raised
whenever an entry's `crop` or `?v=` changes.

## `images.variantsChanged`

`images-default` raises its own event `images.variantsChanged` (`{ id: null, ids, identity: null,
params: {} }`, at most 200 ids per event) through the optional `events@1` contract — declared in
`emits`, never required — whenever it changes what a page would need to re-render for: an item it
placed (made `available`), the items a size-set change or `images.prune` touched, an item whose
focus `images.setFraming` changed, and an item once a render with a changed crop, or any render that
changed a variant's `?v=`, is at its path (see "Focus and crop"). It never raises
`media.updated`, which belongs to the pipeline that edits a medium; a pipeline that marks the pages
showing a medium (`delivery.markDependents:media`) subscribes to both. A rejected emit (no
subscriber, or a subscriber that throws) is logged with the affected ids and does not undo the
change; without any `events@1` provider nothing is raised at all, since nothing could be
subscribed.

## Behaviour

A request to generate the variants of a media item while a render of it runs waits for that render
and then renders once more, since the running render may have read the rows before the request;
every request that arrives meanwhile shares that one further render. Two callers that start a sync
job in the same instant share the same start, so only one job row is ever created. Placing never runs more than four public-copy writes at a time.

Within one process, placing, rendering, `images.remove` and the public-copy sync's writes of one item
run one at a time, so `images.remove` waits for a plan or a render of that item already in progress;
a render stops after the size it is rendering once a remove of its item is waiting. Across processes
the lease on the item (see "Focus and crop") lets one process place, render and write its public
copies at a time. `images.remove` and `images.prune` take no lease. `images.remove` leaves a request
on the item before its first delete, so one that fails partway is finished by `images.resume`; when
leaving that request fails, it still deletes everything and answers that error only when a delete
fails too. A plan or a render reads the
media item through `media@1` again after its last write and, when the item stopped being ready
meanwhile, removes everything it wrote, and a render or public copy written at a path a prune retired
meanwhile leaves no bytes at the private path and the original's bytes in the public copy. Two
planners of one item at once end with one row per size.

`available` (on `images.attach`'s output) is `false` for an eligible image that has at least one size
still `planned` (no object at its path yet), `true` once every size has one — including for a
non-eligible item (not an image, SVG, GIF, or any other XML image type such as `image/foo+xml`,
which a browser would open as a document that can run script), which has no variants at all and is
always available.
`variants[]` never lists a `planned` size; `variantCounts` (`{ done, pending, error, failed }`)
counts a `planned` row as `pending` too, alongside a size with no row yet or a `done` row whose spec
no longer matches the effective size or whose render was cut with another crop than the item's
stored framing gives the size; a row for a size nobody declares any more is ignored.

Not included: AVIF, request-time resizing, rewriting `src`/`srcset` in delivered HTML.

## Storage migrations

`@michaelthielemann/kestrel-images-default/storage` exports `storage()`, the module's storage for
`helpers/shape-migrations` of `kestrel-contracts`, and `migrations`. Its one migration,
`images-default:variant-slots` (introduced in 6.0.0, after `media-default:id-key-layout`), fills in
the `slot` that 5.x rows lack: `<mediaId>/<size>` on each `images_variants` row and
`<mediaId>/<file>` on each `images_retired` row. Where several variant rows share a slot, the newest
finished row stays and the others are dropped and reported; a row without an item, a size or a file
is dropped and reported too. Variant keys did not change, so no blob is written: rows are derived
data, and the next sync renders whatever is missing.

`storageMigrations` (default `check`) decides what setup does with such rows: `check` refuses to
start, naming the migration, the count and how to run it; `apply` runs the migration at start-up.
Offline it runs with `kestrel upgrade migrate --db <file> --blobs-dir <dir>` or as part of
`kestrel update`. A second run changes nothing; a run that stops halfway is finished by running it
again.

## What happens when generation fails or hangs

**A crash mid-render** leaves the variant row in the state it had (`planned`, `pending` or `error`)
with its attempt count unchanged, never at a stale `"done"`, and leaves the lease on the item. The
next `images.generate` or sync pass picks it up once the lease has run out, and so does
`images.resume`, which takes over a lease older than `staleAfterMs`. A `pending` row that never had a
render and whose item no process holds is left to the render queued for it: the `images.planned`
subscriber with a queuing event delivery, or with inline delivery the render this module's background
loop runs after it placed the row. Once that render has run and left a row in `error` (a failed
attempt, or a timeout that kept it from the item's later sizes), `images.resume` renders the item
again once `staleAfterMs` has passed. A row whose queued render is lost with its process waits for
`images.generate` or `images.sync`. Meanwhile `images.serve` hands out that earlier render, or the
full-size original when the path has none yet (header `x-kestrel-variant: original`). A job row whose
`updatedAt` is older than `staleAfterMs` counts as abandoned, so `images.sync` and the
`images.resume` cron take it over instead of answering `CONFLICT`. The job's counters are written
after each image rather than only at the end of a chunk, so a long-running chunk is never mistaken
for a stalled job by `images.readStatus` or the `staleAfterMs` takeover. `images.resume` also places
and renders any item whose lease ran out (a holder that stopped, see "Focus and crop"), any item with
a request left open for longer than `staleAfterMs` (one whose last placement or render failed, or
whose holder stopped before it served the request), any row that already had a render at its path and
was left `pending` for longer than `staleAfterMs` (a re-render that never finished), any row left
`planned` for longer than `staleAfterMs` (a placement that never finished), any row left in `error`
for longer than `staleAfterMs` (a failed attempt below `maxAttempts`), any row of a declared size
planned with another width, height, fit, format or quality than the size now has and untouched for
longer than `staleAfterMs` while no sync job is running (an item a sync job had passed when the size
changed again), and any media item
created in the last 24 hours with no rows at all (a generation that never started). It takes one item
from each of these in turn, at most 200 items per pass, so no group keeps it from the others. It
considers only rows of sizes that are still declared, and moves the rows and requests of the items it
tried but could not advance behind the others, so a few items it cannot place or render never keep it
from the rest; items left out of a pass keep their place. An item among these that `media@1` no
longer reports as ready (an `images.remove` that failed after `media.remove`) has its rows, private
variants and public copies removed. An item it cannot place or render — for
instance one its provider reports as ready but whose bytes it has lost, which `images.plan` and
`images.generate` report as `INTERNAL` (`the stored bytes of media/<id> are missing`) — is logged and
skipped, and the stalled job is resumed regardless. The sync job skips such an item the same way and
counts it as failed; only a `TRANSIENT` failure stops the job, which `images.resume` then resumes.

**A render that hangs** (a pathological image that keeps sharp busy, a blocked file descriptor) is
given up on after `renderTimeoutMs`. sharp gets the same limit, rounded up to whole seconds, and stops
its own processing when it passes; an encoder that reports no progress (AVIF) runs to its end in the
background regardless, and its result is dropped: the variant already carries the failed attempt, and
writing the late result would resurrect a variant the admin was told had failed. The timeout counts as
a normal failed attempt with the error text `render timed out after <n>ms`, and the remaining sizes of
the same item are not rendered in that run, unless that attempt was the size's last; they stay as
they are for the next one, which `images.resume` starts once `staleAfterMs` has passed. Without it the render
would hold its slot for good and the sync job would never reach the next image. A `planned` row
whose render fails this way is left `planned`, not counted as an attempt, and handed to the
background loop to place and render right after the request.

**Repeated failure** is bounded by `maxAttempts`, and a rendered variant whose private blob or public
copy cannot be written counts as a failed attempt too (a placement or a public-copy writer whose
write fails answers the error and counts nothing). A render whose public copy cannot be written, or
whose check after writing it fails, puts the earlier render back at the private path and the public
copy; when the path had none, it removes its bytes from the private path and writes the original's
bytes to the public copy. The origin and the public copy then answer the same bytes under the row's
`?v=`; the item keeps a request that `images.resume` serves. When the private path cannot get its
earlier bytes back, the failed attempt records the render left there and writes it to the public
copy as well. The last failure sets `state: "failed"`
instead of `"error"`, and generate/sync/resume skip the variant from then on, so one broken original
cannot burn the whole budget of the job forever. `images.serve` does not hide such a variant behind
the original: for a size that has never rendered at its path it keeps answering with the original's
bytes and type, marked `x-kestrel-variant: original`, exactly like a `pending` one; a size with an
earlier render at the same path (a re-crop or a redefined size) keeps serving that render. A variant
never 404s once it has been placed. `images.readStatus` counts `failed` per size next to
`done`/`pending`/`error` and adds `failed: { variants, recent }` — the totals over all sizes plus the
twenty most recently failed variants with `mediaId`, `size`, `attempts`, `error` and `updatedAt`,
which is what an admin UI shows.

**Getting out of it** is `images.retryFailed`: it sets every `failed` variant back to `pending` with
`attempts: 0` — all of them, or one media item's with `params.id`/`payload.id` — and then does the
work. The sizes of an original that cannot be decoded stay `failed` with `cannot decode` and are not
counted: their original does not change, so another attempt would fail the same way. For a single
item it regenerates right away and answers `job: null`; for all of them it opens a sync job that
starts at the first media item, because a paused job's cursor may already have passed the affected
ones. It answers `{ variants, media, job }`, and `{ variants: 0, media: 0, job:
null }` when nothing had given up. Redefining a size lifts the quarantine the same way, since a new
spec is new work. There is deliberately **no cancel**: a sync job holds no external resource, every
step it takes is a single idempotent variant write, and it stops by itself at the end of the
library — a cancel would only add a state in which rows are half-written and the next `images.sync`
has to guess whether to trust them. Stopping it is `close()` (teardown), which pauses the job at its
cursor. `close()` also waits for an `images.resume` or a sync start under way: `images.resume` stops
before its next item and answers `CONFLICT`, and neither starts the job again once `close()` has
begun.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-images-default` – module `images/default`: provides no contract; requires `blobstore@1`, `persistence@1`, `media@1`; optional `events@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `sizes` | array | no | – |
| `prefix` | string | no | `"media-variants/"` |
| `publicPath` | string | no | `"/media"` |
| `publicCopy` | object | no | – |
| `publicCopy.prefix` | string | no | – |
| `chunk` | integer | no | `20` |
| `staleAfterMs` | integer | no | `60000` |
| `maxAttempts` | integer | no | `5` |
| `renderTimeoutMs` | integer | no | `30000` |
| `storageMigrations` | enum | no | `"check"` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `images.register` | Replace the sizes registered by this instance – code-declared sizes are held in memory, never stored | – | `result` | { sizes: object[] } | object[] | 400 empty list or invalid size definition; 409 a size collides with a config size | – | no |
| `images.listSizes` | Effective sizes (defaults/config merged with the sizes registered in this process) | – | `result` | – | object[] | – | – | no |
| `images.plan` | Decide every effective size's format, extension, dimensions and path for one media item (id from params.id or payload.id), or for each id in payload.ids, and make its public copies answer with the original's bytes; never renders | – | `result` | { id?: string \| null, ids?: string[], … } | object \| object | 400 missing media id | – | no |
| `images.generate` | Generate variants for one media item (id from params.id or payload.id), or for each id in payload.ids (unknown ids are skipped) | – | `result` | { id?: string \| null, ids?: string[], … } | object \| object | 400 missing media id; 404 media item not found or not ready | – | no |
| `images.sync` | Start a sync job, or resume a paused/error/stale one | – | `result` | – | { id: string, state: "running" \| "paused" \| "done" \| "error", total: number, done: number, failed: number, cursor: string, startedAt: number, updatedAt: number, finishedAt: number \| null, error: string \| null, … } | 409 a fresh job is already running | – | no |
| `images.resume` | Place and render any item left unfinished (a repair pass), then resume a paused/error/stale sync job, or no-op (for cron) | – | `result` | – | object \| null | 409 images are shutting down | – | no |
| `images.retryFailed` | Put every variant that gave up after maxAttempts back to pending with a fresh attempt budget – all of them, or one media item's (id from params.id or payload.id) – and start the work that regenerates them | – | `result` | { id?: string } | { variants: number, media: number, job: object \| null, … } | 404 media item not found or not ready; 409 images are shutting down | – | no |
| `images.prune` | Retire the variants of sizes that are no longer declared: their paths keep answering with the original's bytes until the item is deleted | – | `result` | { sizes: string[] } | { sizes: number, variants: number, … } | 400 missing sizes, or a name is still declared or has no variants | – | no |
| `images.readStatus` | Sizes with usage/variant counts, current job, the variants that gave up with their last error, and sizes whose variants are left over from a size the code no longer declares | – | `result` | – | { sizes: object[], job: object \| null, orphaned: object, registrySeen: boolean, failed: object, … } | – | – | no |
| `images.remove` | Delete one media item's variants and retired paths (blob + rows) | `params.id` | – | – | – | 400 missing id | – | no |
| `images.removeMany` | Delete variants for every id in result.ids (from media.listFolderItems, media.removeFolder or media.purge) | `result.ids` | – | – | – | – | – | no |
| `images.hideMany` | Hide the variants of every id in result.ids (from media.trash or media.trashFolder): their public copies are removed and their paths are neither served, exported nor copied again until images.showMany, while rows and stored variants stay; raises no images.variantsChanged; with result.trashVersions (from the same steps), an id whose variants a later move already showed is left alone | `result.ids`, `result.trashVersions?` | – | – | – | – | – | no |
| `images.showMany` | Show the variants of every id in result.ids again (from media.restore) and write their public copies; raises no images.variantsChanged; with result.trashVersions, an id whose variants a later move already hid stays hidden | `result.ids`, `result.trashVersions?` | – | – | – | – | – | no |
| `images.setFraming` | Replace the framing of one media item (params.id): a focus rectangle and manual crops keyed by reduced ratio, normalised to 0..1 on the oriented original; an empty one removes it. Re-plans the item, so each cover size whose crop changes renders again at its path while the old variant keeps being served; raises images.variantsChanged when the focus changes | `params.id` | `result` | { focus?: object \| null, crops?: object } | { id: string, framing: object, … } | 400 missing id, or an invalid focus or crop; 404 media item not found, not ready, hidden or without variants | – | no |
| `images.attach` | Add available, variants[], variantCounts, focus and framing to a media item or list (result.id or result.items); a variant whose path has no object yet is never listed, a hidden item lists no variants and is not available, and framing.ratios has one entry per ratio of the cover sizes | `result` | `result.available?`, `result.variants?`, `result.variantCounts?`, `result.focus?`, `result.framing?` | – | { available: boolean, variants: object[], variantCounts: object, focus: object \| null, framing: object, … } | – | – | no |
| `images.serve` | The variant at its public URL (params.id, params.file), or the original's bytes when no render is at that path yet; x-kestrel-variant: original marks the fallback | `params.id`, `params.file` | `result` | – | – | 400 missing id or file; 404 media item not found, not ready or hidden, or the file is neither a current nor a retired size | – | no |
| `images.syncPublic` | Reconcile the public copies of every ready item's variants and retired paths with the stored rows: place missing sizes, write missing or mismatched copies, and remove copies of deleted or hidden items and foreign files (adds _publicVariants: { written, removed, planned, missing } to the result) | – | `result._publicVariants` | – | { _publicVariants: object, … } | – | – | no |
| `images.export:<arg>` | Copy every done variant of a ready, not hidden media item to <arg>/<folder>/<filename>.<size>.<ext> | – | `result.variants` | – | { variants: object, … } | – | – | no |

Used by 24 of 111 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
