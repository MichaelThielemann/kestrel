# @michaelthielemann/kestrel-openapi
Generates an OpenAPI 3.1 document from a booted Kestrel instance: one operation per HTTP
trigger, path params from `:id`/`*path`, request body, query parameters, responses, error
statuses and bearer security from the step descriptions modules provide via `describe()`.
Steps without an output schema still appear (unknown body/response). Output is deterministic –
check it in. CLI: `kestrel-openapi --out openapi.json [--title t] [--version v] [--server url] [--mount /api]`
run in a project with `kestrel.config.ts`; it boots the instance without HTTP. Programmatic:
`generateOpenApi(kestrel, info)`.

The shared `Error` schema matches the runtime error body: `error`, `code`, `retryable` and `runId`
are required, `step` and `details` are optional. Every operation gets a default `500` response
(and a default `503`, since any step can fail with `TRANSIENT`); a `400` is added for
POST/PUT/PATCH when no step declares one. `429` and `503` responses carry a documented
`Retry-After` header.
