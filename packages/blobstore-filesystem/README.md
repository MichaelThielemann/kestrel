# blobstore/filesystem
`blobstore@1` on a local directory: key `a/b.png` becomes `<root>/a/b.png`, nothing else. The
store keeps bytes only – the `contentType` hint of `put` is ignored, the module owning an object
knows its type (media from its row, images from the variant row, delivery from the extension).
Keys must be relative, without `.`/`..` segments, and must not end in `.meta.json`: files with
that suffix are ignored by `list` and cannot be written. Config: `{ root: "./data/blobs" }`.
For local development and tests; on ephemeral disks use `blobstore-s3`.

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
