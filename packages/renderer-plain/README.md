# renderer/plain
Reference `renderer@1`: one HTML page per document (title as heading, the document as JSON).
Formats: `html`. Meant for examples and tests; real sites provide their own renderer module
(e.g. the Nuxt layer in kestrel-web) implementing the same contract – `delivery-static` does not care which.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-renderer-plain` – module `renderer/plain`: provides `renderer@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `titleField` | string | no | `"title"` |
| `siteName` | string | no | `"Kestrel"` |

<!-- kestrel-docs:end -->
