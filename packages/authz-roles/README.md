# authz/roles
`authz@1` with roles from config: `roles: { admin: ["*"], editor: ["pages.*"] }`. The identity's
roles come from `identity.claims[roleClaim]` (default `roles`, string or string[]), set by the
authn module. Permissions are dotted names; `x.*` grants everything below `x`.
`anonymous: ["pages.read"]` lists what a request without identity may do.
Step: `authz.require:<permission>` – passes without identity if `anonymous` grants it, else
`UNAUTHENTICATED`; `FORBIDDEN` when the identity lacks the permission.
Step: `authz.describePipelineAccess` – writes `result.pipelineAccess`: for every booted pipeline,
`granted` when the caller passes all of its `authz.require:<perm>` steps, `denied` when it fails
one, `unknown` when it has none (another step may still refuse the call). Without an identity the
`anonymous` grants decide, exactly as in `authz.require`. A client can hide what it may not run
without a copy of the role table.
The answer names every booted pipeline and shows what an anonymous caller may run, so the step
belongs behind `authn.requireUser`; do not put it in a route an anonymous caller can reach.
Step: `authz.listRoles` – writes `result.roles`, the configured role names in config order. It does
not check a permission itself; gate it with `authz.require:<perm>` ahead of it (`examples/minimal`
requires `users.manage`) so that only a caller who may manage users learns the role table.
A role name a caller was never meant to have (`constructor`, `toString`, `valueOf`,
`hasOwnProperty`, `__proto__`, …) never resolves to an inherited `Object.prototype` value: role
lookups go through a `Map`, not a plain object index.
`authz.describePipelineAccess` needs an attached, booted instance (`kestrel.describe()` from the
`attach` hook); a `testing/runPipeline` unit test that does not boot gets a wiring error from it –
see `module.test.ts` for the `boot()` pattern.
Not included: ownership/resource checks (the `resource` argument is ignored), roles stored in a database.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authz-roles` – module `authz/roles`: provides `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `roles` | record | yes | – |
| `roleClaim` | string | no | `"roles"` |
| `anonymous` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `authz.require:<arg>` | Requires permission <arg> | – | – | – | – | 401 not authenticated; 403 missing permission <arg> | – | no |
| `authz.describePipelineAccess` | Per booted pipeline, whether the caller passes its authz.require steps | `identity?` | `result.pipelineAccess` | – | { pipelineAccess: object, … } | – | – | no |
| `authz.listRoles` | The configured role names, in config order | – | `result.roles` | – | { roles: string[], … } | – | – | no |
| `authz.validateRoles:<arg>` | Validate the role names at payload.<arg> against the configured roles; an absent value passes. authz.validateRoles:roles reads payload.roles, the shape authn.createUser and authn.updateUser accept | `payload.<arg>` | – | object | – | 400 the value is not an array of known role names | – | no |

Used by 65 of 86 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
