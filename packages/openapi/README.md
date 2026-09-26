# @michaelthielemann/kestrel-openapi
Generates an OpenAPI 3.1 document from a booted Kestrel instance: one operation per HTTP
trigger, path params from `:id`/`*path`, request body, query parameters, responses, error
statuses and bearer security from the step descriptions modules provide via `describe()`.
Steps without an output schema still appear (unknown body/response). Output is deterministic –
check it in. This package is the library; the command is `kestrel openapi --out openapi.json [--title t]
[--version v] [--server url] [--mount /api]` from `@michaelthielemann/kestrel-cli`, run in a project with
`kestrel.config.ts` (see its README). Programmatic: `generateOpenApi(kestrel, info)`.

The shared `Error` schema matches the runtime error body: `error`, `code`, `retryable` and `runId`
are required, `step` and `details` are optional. Every operation gets a default `500` response
(and a default `503`, since any step can fail with `TRANSIENT`); a `400` is added for
POST/PUT/PATCH when no step declares one. `429` and `503` responses carry a documented
`Retry-After` header.

An operation whose last step declares `narrows` (such as `authz-roles`' `authz.fields`) answers each
audience a different shape. Its 200 is `anyOf` the full answer, `#/components/schemas/<operationId>`,
and one component per audience label, `#/components/schemas/<operationId>.<label>` with a `:` in the
label read as `.` (`getMedia.anonymous`, `getMedia.role.reviewer`); a label that cannot name a
component is left out. An audience's component keeps the paths its label lists, with the items where
the declaration's `shape` says, and is closed (`additionalProperties: false`) at every object a path
passes through; a member granted whole keeps its declared schema, and an answer a step ends the run
with before the narrowing step stays as declared. The 200 carries `x-kestrel-answers`, mapping each
label to its component. A file operation keeps its binary 200 and lists in `x-kestrel-answers` the
response headers each audience receives.
