# sanitize/svg
Sanitizes uploaded SVG files against an allowlist of shape/text/gradient/filter tags and
presentation attributes. Config: `maxBytes` (default 2 MiB). Step `sanitize.svg` before
`media.upload`: rejects an oversize file with `PAYLOAD_TOO_LARGE` (413) and invalid markup with
`VALIDATION` (400), replaces the file's bytes with the cleaned SVG (`image/svg+xml`); non-SVG
files pass through untouched. Removed:
`<script>`, `<style>`, `<foreignObject>`, `<image>`, `on*` handlers, `animate*`/`set`, and any
`href`/`xlink:href` that is not an internal `#...` reference. Inline delivery of sanitized SVGs
still needs `image/svg+xml` in core's `http.inlineTypes` – and the other way round: that entry
without this module (or another one registering `sanitize.svg`) fails the boot.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-sanitize-svg` – module `sanitize/svg`: provides no contract.

| Config | Type | Required | Default |
|---|---|---|---|
| `maxBytes` | integer | no | `2097152` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `sanitize.svg` | Sanitize uploaded SVG files (scripts, handlers, external references removed) | `files` | `files` | – | – | 400 invalid svg; 413 svg too large |

Pipelines in `examples/minimal` using these steps:

- **uploadMedia** (POST /media): `authn.requireUser` → `authz.require:media.write` → **`sanitize.svg`** → `media.upload` → `events.emit:media.uploaded`

<!-- kestrel-docs:end -->
