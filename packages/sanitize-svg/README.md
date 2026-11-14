# sanitize/svg
Sanitizes uploaded SVG files against an allowlist of shape/text/gradient/filter tags and
presentation attributes. Config: `maxBytes` (default 2 MiB). Step `sanitize.svg` before
`media.upload`: rejects an oversize file with `PAYLOAD_TOO_LARGE` (413) and invalid markup with
`VALIDATION` (400), replaces the file's bytes with the cleaned SVG (`image/svg+xml`); non-SVG
files pass through untouched. A file counts as SVG when it is declared `image/svg+xml` or when it is
declared as another image type (or PDF) and its bytes are SVG markup (`verifiedMediaType`). Removed:
`<script>`, `<style>`, `<foreignObject>`, `<image>`, `on*` handlers, `animate*`/`set`, and any
`href`/`xlink:href` that is not an internal `#...` reference, and any attribute holding a `url(...)`
that does not point to a `#fragment` of the same file (`fill="url(http://…)"` goes, `fill="url(#g)"`
stays). Serve a sanitized SVG with `Content-Security-Policy: default-src 'none'; sandbox`, as the
Node origin does, so that nothing in the file can load a resource. Inline delivery of sanitized SVGs
still needs `image/svg+xml` in core's `http.inlineTypes` – and the other way round: that entry
without this module (or another one registering `sanitize.svg`) fails the boot. `media-default`
publishes an SVG as `image/svg+xml` only when this step ran before `media.upload` in the same
pipeline, with no step in between that declares a write to `files`.

Not included: deciding whether SVG uploads are allowed at all, storage, naming and serving of the
file (`media-default`'s `allowedTypes`/`deniedTypes` and the pipeline order that makes an upload
count as sanitized); full XML well-formedness or schema validation – a tag or attribute outside the
allowlist is dropped, not rejected, and the file only fails when no `<svg>` root element survives
that; reading width/height or any other rasterization (`media-default` reads image dimensions from
the file header, not from this module).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-sanitize-svg` – module `sanitize/svg`: provides no contract.

| Config | Type | Required | Default |
|---|---|---|---|
| `maxBytes` | integer | no | `2097152` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `sanitize.svg` | Sanitize uploaded SVG files, also SVG content declared as another image type (scripts, handlers, external references removed) | `files` | `files` | – | – | 400 invalid svg; 413 svg too large | – | no |

Pipelines in `examples/minimal` using these steps:

- **uploadMedia** (POST /media): `authn.requireUser` → `authz.requireRole` → `authz.require:media.write` → **`sanitize.svg`** → `media.upload` → `events.emit:media.uploaded` → `events.relay`

<!-- kestrel-docs:end -->
