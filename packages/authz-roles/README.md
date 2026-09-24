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

At `attach()`, this module also checks every step across every booted pipeline that declares
`anonymous: "required"` (`StepDescription`) — its output is published where no access check applies,
so every pipeline that runs it must actually let an anonymous caller through. Boot fails, naming the
pipeline, the step and either the permission anonymous callers lack or the authn step (other than
`authz.require` itself) that requires a signed-in caller. This is a check by this module only:
`authz@1` carries no anonymous verdict, so a different `authz@1` provider has to perform the same
check itself, or the flag goes unchecked under it. `authz.require` checks a signed-in caller's roles
only, never the `anonymous` grants: a signed-in user whose roles lack a permission is refused where an
anonymous caller passes. A pipeline serving output that is published anyway should therefore not
gate it with `authz.require` at all; the example serves `/media/:id/:name` and
`/media/:id/variants/:file` with `media.serve` and `images.serve` alone.
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

Used by 65 of 89 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
