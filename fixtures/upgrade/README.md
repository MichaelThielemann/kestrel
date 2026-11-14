# Upgrade fixtures

`fixtures/upgrade/<version>/` holds the data of a real instance of a published release: the SQLite
database, the blob tree and the replica (snapshot plus write-ahead-log segments). Tests use it to boot
newer code against the storage formats an older release wrote, without network access.

The content is invented. Nothing in it comes from a real site; the users are `admin` / `kestrel-demo`
and `fixture-editor` / `fixture-editor-pw`.

## What `5.8.1/` contains

| Path | Content |
|---|---|
| `kestrel.db` | the database, checkpointed into one file (no `-wal` or `-shm` next to it) |
| `blobs/media/…` | originals under `media/<folder>/<filename>`: nested folders, the same filename in two folders, one PDF, one SVG, one item whose original is missing |
| `blobs/media-variants/<id>/<size>.<ext>` | variants in three sizes, one of them in the original format; one medium has two extra rows for the same size |
| `blobs/site/…` | the static export: pages in two languages, `llms.txt`, `llms-full.txt`, `redirects.json` |
| `blobs/site/media/<folder>/<filename>[.<size>.<ext>]` | the media copies the export writes for every `/media/<id>/file` and `/media/<id>/variants/<size>.<ext>` reference in a page: both `photo.png` files side by side, a nested folder, a PDF, an SVG, webp variants, one in the original format, and a variant whose original is gone |
| `blobs/backups/kestrel.db[.<time>]` | what `backup-blobstore` writes: the database and two timestamped versions of it |
| `blobs/replica/gen/<generation>/…` | one snapshot and three segments spread over two log lineages; restoring them reproduces `kestrel.db` row for row |
| `manifest.json` | the pinned package versions, the ids of the special cases, the image sizes and trigger setup the instance booted with (`config`), the row count of every collection and the list of blobs |

Pages, revisions (one of them labelled) and the reference index point at media; there are two users,
three audit entries, a redirect rule set, settings in two languages and a link index entry.

## Regenerate

```
node scripts/seed-upgrade-fixture.mjs [--out <dir>] [--keep-work]
```

The generator needs network access, `git` with the tag `v5.8.1` and Node 22.18 or later. It

1. takes the reference instance (`examples/minimal`) from the release tag,
2. installs every `@michaelthielemann/kestrel*` package of it, plus `kestrel-backup-blobstore`, from the npm
   registry, pinned to exactly the release version, and refuses to continue if the install resolves anything else,
3. boots it in-process with three image sizes, fills it through its own pipelines (page bodies reference media by URL, so the export copies them) and
   writes the special cases directly,
4. replicates in several steps, stops the instance, backs the database up twice and copies `data/` to the
   output directory.

Ids, blob paths and timestamps are new on every run, so two runs are not byte-identical; the shape of
the manifest, the special cases it names and the row counts are stable. `sharp` and `zod` are not pinned by kestrel; their resolved versions are recorded
in the manifest.

## Booting it on its own release

`scripts/upgradeFixtureRelease.test.ts` boots the release the fixture comes from on a copy of the data,
before and after `kestrel upgrade migrate --plan` read it, and checks that it signs in, serves a medium
and lists the pages. It needs that release installed and is skipped otherwise. Point it at the project
directory `--keep-work` leaves (`<work>/project`), or at any copy of the tag's `examples/minimal` with
the release's packages installed; the test itself reads no network:

```
KESTREL_UPGRADE_RELEASE_PROJECT=<work>/project pnpm vitest run scripts/upgradeFixtureRelease.test.ts
```

## Reading it in a test

Boot the fixture with the configuration recorded in `manifest.json` under `config`: the three image
sizes (`config.images.sizes`, the same specs `images_variants.spec` holds) replace the default sizes of
`images-default`, and only the event triggers are registered: no HTTP triggers and no cron triggers (`config.httpTriggers`,
`config.triggers`). A cron run would change the data of the copy, for example by expiring the admin session. With the default sizes
every `thumb` and `small` variant counts as outdated and every `wide` variant as an orphaned size.

Open a copy of `kestrel.db`, never the file itself: SQLite creates `-wal` and `-shm` next to a
database in write-ahead-log mode even for a read-only connection, and a stray file there fails the
integrity test. The blob tree is read-only for every consumer. `.gitattributes` keeps git from converting line endings in
the fixture, so every checksum holds on every platform.
