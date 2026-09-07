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
problem. Not included: `$ref` to remote schemas, custom keywords.
