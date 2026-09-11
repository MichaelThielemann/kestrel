# insights/default
`insights@1`: one view of the running instance. `manifest()` is the core's `kestrel.describe()`
(modules with version, contracts, config schema and variables, steps with their descriptions,
pipelines with step order, triggers) — static, computed once, never containing a config value;
`stats()` aggregates the core's run observer in this process: count, failed (every non-ok
outcome), errors (5xx), p50/p95 ms per pipeline and per step spec, active runs, uptime,
event-triggered runs per event name. The module hooks in through the core's `attach` lifecycle
hook and detaches on `stop()`. Numbers are per process and start at zero on every boot.
Config: `{}`, nothing to set. Steps: `insights.readManifest` (adds `generatedAt`),
`insights.readStats`; both write `result` and read nothing — guard them with
`authn.requireUser` and `authz.require:insights.read` in the pipeline.
Not included: routes (the consumer's `kestrel.config.ts` wires them), persistence or time series
(OpenMetrics/Prometheus is the way there), ratelimit buckets (`ratelimit` stays `[]` until a
ratelimit contract exists), numbers across processes.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-insights` – module `insights/default`: provides `insights@1`.

Config: `{}` – nothing to set.

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `insights.readManifest` | The static manifest of this instance: modules, contracts, config schemas, steps, pipelines, triggers | – | `result` | – | { generatedAt: number, core: object, contracts: string[], modules: object[], steps: object[], pipelines: object[], triggers: object, … } | – |
| `insights.readStats` | Live counters of this process: runs, pipelines, steps, events | – | `result` | – | { generatedAt: number, process: object, runs: object, pipelines: object[], steps: object[], events: object[], ratelimit: object[], … } | – |

Pipelines in `examples/minimal` using these steps:

- **insightsManifest** (GET /admin/insights/manifest): `authn.requireUser` → `authz.require:insights.read` → **`insights.readManifest`**
- **insightsStats** (GET /admin/insights/stats): `authn.requireUser` → `authz.require:insights.read` → **`insights.readStats`**

<!-- kestrel-docs:end -->
