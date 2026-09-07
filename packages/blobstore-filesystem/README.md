# blobstore/filesystem
`blobstore@1` on a local directory: key `a/b.png` becomes `<root>/a/b.png` plus a sidecar
`a/b.png.meta.json` holding the content type. Keys must be relative, without `.`/`..` segments.
Config: `{ root: "./data/blobs" }`. For local development and tests; on ephemeral disks use
`blobstore-s3`.
