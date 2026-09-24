# blobstore/filesystem
`blobstore@1` on a local directory: key `a/b.png` becomes `<root>/a/b.png`, nothing else. The
store keeps bytes only – the `contentType` hint of `put` is ignored, the module owning an object
knows its type (media from its row, images from the variant row, delivery from the extension).
Keys must be relative, without `.`/`..` segments, and must not end in `.meta.json` or
`.kestrel-tmp`: files with either suffix are ignored by `list` and cannot be written. Config:
`{ root: "./data/blobs" }`. For local development and tests; on ephemeral disks use `blobstore-s3`.

`put` replaces a file atomically: it writes the bytes to a temporary file in the same directory
(`<key>.<uuid>.kestrel-tmp`) and renames it onto the key, which is atomic within one file system.
A reader – this store's `get`, or a web server serving the directory directly – always sees the
old file or the new one, never a partially written one. A crash between the write and the rename
can leave a temporary file behind; it is never listed or read, and its name is unguessable.

## Errors

Four transient IO codes (`EBUSY`, `EMFILE`, `ENFILE`, `EAGAIN`) become an `Err(TRANSIENT)`;
everything else is rethrown, because it is a wiring bug rather than an expected failure.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-blobstore-filesystem` – module `blobstore/filesystem`: provides `blobstore@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `root` | string | yes | – |

<!-- kestrel-docs:end -->
