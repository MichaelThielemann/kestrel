# authz/roles
`authz@1` with roles from config: `roles: { admin: ["*"], editor: ["pages.*"] }`. The identity's
roles come from `identity.claims[roleClaim]` (default `roles`, string or string[]), set by the
authn module. Permissions are dotted names; `x.*` grants everything below `x`.
`anonymous: ["pages.read"]` lists what a request without identity may do, and every signed-in
caller may do it too, whatever its roles: `can` answers true when the roles or `anonymous` grant the
permission.
Step: `authz.require:<permission>` – passes without identity if `anonymous` grants it, else
`UNAUTHENTICATED`; `FORBIDDEN` when neither the identity's roles nor `anonymous` grant the permission.
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
pipeline, the step and either the permission anonymous callers lack, the authn step (other than
`authz.require` itself) that requires a signed-in caller, or the missing `authz.require` step: a
pipeline running such a step without any `authz.require` fails boot too, since it would publish
whatever `anonymous` grants. This is a check by this module only: `authz@1` carries no anonymous
verdict, so a different `authz@1` provider has to perform the same check itself, or the flag goes
unchecked under it.
Field grants: `anonymousFields: { media: ["id", "path", "variants[].path"] }` says which members of
an answer a caller without an identity keeps, per resource; `fields: { reviewer: { media: ["folder"]
} }` does the same per role (a role `fields` names must be defined in `roles`). Step:
`authz.fields:<resource>?shape=<item|list|array|file>`, last in a pipeline, cuts `result` to the
caller's set: without an identity, or with one that holds no configured role, the anonymous grant
(403 `FORBIDDEN` when there is none) — such a caller never sees everything; otherwise everything when
one of its configured roles has no grant for the resource, else the union of its roles' grants and
the anonymous one. `shape` says where the items are, and the step's parameter decides it: `item` is
the whole answer (also one with an `items` member), `list` every element of `items` in
`{ items, total }` (`total` stays, every other envelope member goes), `array` every element, `file` a
binary answer whose bytes, type and name stay and whose response headers are cut to the granted
`headers.<name>` (case-insensitive). A path is relative to
one item: `title` keeps the member whole, `provenance.origin` keeps `provenance` holding only
`origin`, `variants[].path` keeps the array `variants` whose elements hold only `path`; a whole grant
wins over a sub-path of the same member, and a map or a free-form value is granted whole. A value
that is not an object (`null`, a string) is kept as it is. The step declares `narrows` with one
answer per audience (`anonymous`, `role:<name>`), so `kestrel-openapi` documents each.

At `attach()` boot fails, one line per problem, when a step runs after `authz.fields`; when the
declared output does not fit the shape parameter (`item` fits any object, `list` an object whose
`items` is an array of objects, `array` an array of objects, `file` a pipeline with a `binary`
step; every branch of a union must fit); when a pipeline an anonymous caller reaches does not end with the step (an HTTP trigger, no
step besides `authz.require` declaring `security: "required"`, every `authz.require` permission in
`anonymous`, a step writing `result`, and no step up to that one writing `identity` unconditionally,
which exempts a login); when such a pipeline's resource has no anonymous grant; when an answer a step
before the cut ends the run with (`terminalOutput`) is open or carries a member the anonymous grant
or a role's grant (joined with the anonymous one) does not name, in every pipeline ending with the
step; when a grant names a path no pipeline ending with `authz.fields:<resource>` declares
(with the way to write it, e.g. `"variants" is a list, write "variants[].path"`; a file grant names
only `headers.<name>`); and when a grant's resource is cut by no pipeline. `anonymousPipelines`,
`fieldSet`, `answersOf` and `fieldGrantProblems` in `./impl` expose the same rules.

Not included: ownership/resource checks (the `resource` argument is ignored), roles stored in a database.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authz-roles` – module `authz/roles`: provides `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `roles` | record | yes | – |
| `roleClaim` | string | no | `"roles"` |
| `anonymous` | array | no | `[]` |
| `anonymousFields` | record | no | `{}` |
| `fields` | record | no | `{}` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `authz.require:<arg>` | Requires permission <arg> | – | – | – | – | 401 not authenticated; 403 missing permission <arg> | – | no |
| `authz.describePipelineAccess` | Per booted pipeline, whether the caller passes its authz.require steps | `identity?` | `result.pipelineAccess` | – | { pipelineAccess: object, … } | – | – | no |
| `authz.listRoles` | The configured role names, in config order | – | `result.roles` | – | { roles: string[], … } | – | – | no |
| `authz.fields:<arg>` | Keep only the <arg> fields the caller may see: anonymousFields.<arg> without an identity or a configured role; otherwise everything when one of its roles has no field grant for <arg>, else the union of its roles' grants and the anonymous one | `identity?`, `result?` | `result?` | – | – | 403 no field grant on <arg> for a caller without an identity or a configured role | – | no |
| `authz.validateRoles:<arg>` | Validate the role names at payload.<arg> against the configured roles; an absent value passes. authz.validateRoles:roles reads payload.roles, the shape authn.createUser and authn.updateUser accept | `payload.<arg>` | – | object | – | 400 the value is not an array of known role names | – | no |

Used by 68 of 93 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
