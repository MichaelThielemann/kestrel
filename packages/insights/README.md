# insights/default
`insights@1`: one view of the running instance. `manifest()` is the core's `kestrel.describe()`
(modules with version, contracts, config schema and variables, steps with their descriptions,
pipelines with step order, triggers) — static, computed once;
`stats()` aggregates the core's run observer in this process: count, failed (every non-ok
outcome), errors (5xx), p50/p95 ms per pipeline and per step spec, active runs, uptime,
event-triggered runs per event name, and a ring buffer of the last failed runs
(`recentFailures`, newest first: time, run id, pipeline, trigger, status, duration, code, step and
the message the caller received — truncated, never a stack). The module hooks in through the
core's `attach` lifecycle hook and detaches on `stop()`. Numbers are per process and start at
zero on every boot.
Every config variable in the manifest carries its effective value: `value` is what the config sets,
otherwise the default, `null` when nothing applies, and `status` says which of the two it is. The
value is a JSON snapshot — functions, class instances and Buffers become type labels, long strings
and large arrays/objects are cut with a marker. A secret is never in it: `redacted: true` with
`value: null` covers everything the schema marks secret and everything whose key name or value looks
like a credential, nested keys inside a shown value included (`"[redacted]"`). A module author marks
a secret with `.describe("secret")` on the zod field (the core's `SECRET` constant); a config schema
written as JSON Schema marks it with `writeOnly: true`, `format: "password"` or `x-secret: true`.
Because values are on show, `insights.readManifest` belongs behind a login and `insights.read` — as
in the example pipelines below.
Config: `{ recentFailures }` — how many failed runs to keep (default 50, `0` turns the buffer
off). Steps: `insights.readManifest` (adds `generatedAt`),
`insights.readStats`; both write `result` and read nothing — guard them with
`authn.requireUser` and `authz.require:insights.read` in the pipeline.
Not included: routes (the consumer's `kestrel.config.ts` wires them), persistence or time series
(OpenMetrics/Prometheus is the way there), ratelimit buckets (`ratelimit` stays `[]` until a
ratelimit contract exists), numbers across processes.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-insights` – module `insights/default`: provides `insights@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `recentFailures` | integer | no | `50` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `insights.readManifest` | The static manifest of this instance: modules, contracts, config schemas, steps, pipelines, triggers | – | `result` | – | { generatedAt: number, core: object, contracts: string[], modules: object[], steps: object[], pipelines: object[], triggers: object, … } | – |
| `insights.readStats` | Live counters of this process: runs, pipelines, steps, events, and the most recent failed runs | – | `result` | – | { generatedAt: number, process: object, runs: object, pipelines: object[], steps: object[], events: object[], ratelimit: object[], recentFailures: object[], … } | – |

Pipelines in `examples/minimal` using these steps:

- **insightsManifest** (GET /admin/insights/manifest): `authn.requireUser` → `authz.require:insights.read` → **`insights.readManifest`**
- **insightsStats** (GET /admin/insights/stats): `authn.requireUser` → `authz.require:insights.read` → **`insights.readStats`**

<!-- kestrel-docs:end -->
