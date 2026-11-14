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
| `blobs/replica/gen/<generation>/…` | one snapshot and three segments spread over two log lineages; restoring them reproduces `kestrel.db` row for row |
| `manifest.json` | the pinned package versions, the ids of the special cases, the row count of every collection and the list of blobs |

Pages, revisions (one of them labelled) and the reference index point at media; there are two users,
three audit entries, a redirect rule set, settings in two languages and a link index entry.

## Regenerate

```
node scripts/seed-upgrade-fixture.mjs [--out <dir>] [--keep-work]
```

The generator needs network access, `git` with the tag `v5.8.1` and Node 22.18 or later. It

1. takes the reference instance (`examples/minimal`) from the release tag,
2. installs every `@michaelthielemann/kestrel*` package from the npm registry, pinned to exactly the
   release version, and refuses to continue if the install resolves anything else,
3. boots it in-process with three image sizes, fills it through its own pipelines and writes the
   special cases directly,
4. replicates in several steps, stops the instance and copies `data/` to the output directory.

Ids and timestamps are new on every run, so two runs are not byte-identical; the manifest and the
counts are stable. `sharp` and `zod` are not pinned by kestrel; their resolved versions are recorded
in the manifest.

## Reading it in a test

Open a copy of `kestrel.db`, never the file itself: SQLite creates `-wal` and `-shm` next to a
database in write-ahead-log mode even for a read-only connection, and a stray file there fails the
integrity test. The blob tree is read-only for every consumer.
