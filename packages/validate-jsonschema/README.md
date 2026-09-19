# validate/jsonschema
Provides `validate@1`. Validates one payload field against a JSON Schema (draft 2020-12, `ajv` + `ajv-formats`).
Config: `schemas: { "pages.body": "./schemas/blocks.json", "settings.navigation": { type: "array", … } }` —
a string is a path resolved against `deps.root` (the directory of the loaded `kestrel.config`; an
absolute path also works), an object is the JSON Schema itself (for bundled builds that carry no
schema files). Both forms compile, sanitize and report identically. Schemas are read and
compiled at boot – unreadable or invalid files and invalid inline schemas stop the boot. With
`watch: true`, each schema *file* is watched (`fs.watch`, debounced ~100ms; inline schemas have nothing to
watch) and reloaded on change: a broken update (unreadable,
invalid JSON, or a schema ajv rejects) is reported through the Kestrel logger at level `error`
and the previous, still-working schema stays in effect – a broken schema file never stops the process.
A failed read is retried once after a short delay, because an editor or git write can leave the file
briefly truncated between the change event and the final content; reloads of one target run on a
promise chain of their own, so a slow reload from an earlier event cannot overwrite the result of a
later one that already finished.
Recommended on for standalone dev (`pnpm start`), off in production. Step `validate.check:<type>.<field>` before `content.create/update`: `VALIDATION` (400) with
`details.problems` (`<path> <message>` per problem, same text also in the error message) and, for
each problem at the field's root (`path: "/"`), a matching `details.fields` entry
(`{ field, message }`); an absent or `null` field passes (required-ness is the content
model's job). The schema itself belongs to the frontend (pagebuilder block library): one file,
used by the editor for UX and by Kestrel for enforcement.
`validate.sanitize:<type>.<field>` rewrites strings at schema positions marked `format: "html"`
through an allowlist (`HTML_ALLOWLIST` in `sanitize.ts`: text/list/table tags, `a[href|title|target|rel]`,
`img[src|alt|…]`, schemes http/https/mailto/tel/kestrel, `data-kestrel-broken` on links; everything
else is dropped) – run it before `validate.check`. `validate.sanitizeHtml:<field>` does the same for a
whole string field (richtext content fields). `oneOf` unions whose branches carry `properties.type.const` (block libraries) are turned into ajv
discriminators at load time: only the matching branch is validated, an unknown `type` yields one
problem. A plain nullable wrapper (`anyOf: [schema, { type: "null" }]`) carries no discriminator, so
the sanitizer selects its branch by `type` instead. Not included: `$ref` to remote schemas, custom keywords.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-validate-jsonschema` – module `validate/jsonschema`: provides `validate@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `schemas` | record | yes | – |
| `maxDepth` | integer | no | `32` |
| `maxNodes` | integer | no | `20000` |
| `watch` | boolean | no | `false` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `validate.sanitize:<arg>` | Sanitize HTML at format:"html" positions of payload field <arg> | – | `payload.<arg>?` | object | – | – |
| `validate.sanitizeHtml:<arg>` | Sanitize the HTML payload field <arg> | – | `payload.<arg>?` | object | – | – |
| `validate.check:<arg>` | Validate payload field <arg> against its JSON Schema | – | – | object | – | 400 schema violation (path and message per problem) |

Pipelines in `examples/minimal` using these steps:

- **createPage** (POST /pages): `authn.requireUser` → `authz.require:pages.write` → **`validate.check:pages.body`** → **`validate.sanitize:pages.body`** → **`validate.check:pages.body`** → `references.check:pages` → `content.create:pages` → `revisions.record:pages` → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.created`
- **restorePageRevision** (POST /admin/pages/:id/revisions/:revisionId/restore): `authn.requireUser` → `authz.require:pages.write` → `revisions.restore:pages` → **`validate.check:pages.body`** → **`validate.sanitize:pages.body`** → **`validate.check:pages.body`** → `references.check:pages` → `content.update:pages` → `revisions.record:pages` → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `revisions.reportRestore` → `events.emit:page.restored`
- **setRedirects** (PUT /redirects): `authn.requireUser` → `authz.require:redirects.write` → **`validate.check:redirects.rules`** → `redirects.validate` → `content.set:redirects` → `redirects.export`
- **setSettings** (PUT /settings): `authn.requireUser` → `authz.require:settings.write` → **`validate.check:settings.navigation`** → `content.set:settings` → `delivery.exportLlms`
- **updatePage** (PATCH /pages/:id): `authn.requireUser` → `authz.require:pages.write` → **`validate.check:pages.body`** → **`validate.sanitize:pages.body`** → **`validate.check:pages.body`** → `references.check:pages` → `content.update:pages` → `revisions.record:pages` → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.updated`

<!-- kestrel-docs:end -->
