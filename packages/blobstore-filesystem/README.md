# blobstore/filesystem
`blobstore@1` on a local directory: key `a/b.png` becomes `<root>/a/b.png`, nothing else. The
store keeps bytes only – the `contentType` hint of `put` is ignored, the module owning an object
knows its type (media from its row, images from the variant row, delivery from the extension).
Keys must be relative, without `.`/`..` segments, and must not end in `.meta.json`. Config:
`{ root: "./data/blobs" }`. Earlier versions wrote a `*.meta.json` sidecar next to every blob;
those files are ignored by `list` and can be deleted once with
`find <root> -name '*.meta.json' -delete`. For local development and tests; on ephemeral disks
use `blobstore-s3`.
