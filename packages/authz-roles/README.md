# authz/roles
`authz@1` with roles from config: `roles: { admin: ["*"], editor: ["pages.*"] }`. The identity's
roles come from `identity.claims[roleClaim]` (default `roles`, string or string[]), set by the
authn module. Permissions are dotted names; `x.*` grants everything below `x`.
`anonymous: ["pages.read"]` lists what a request without identity may do.
Step: `authz.require:<permission>` – passes without identity if `anonymous` grants it, else
`UNAUTHENTICATED`; `FORBIDDEN` when the identity lacks the permission.
Step: `authz.describeAccess` – writes `result.permissions`: the caller's roles' patterns expanded
against every permission a booted pipeline requires via `authz.require:<perm>`. Requires an
identity. No client needs a copy of the pattern matcher: `permissions` already lists only
concrete, granted names.
Step: `authz.listRoles` – writes `result.roles`, the configured role names in config order. It does
not check a permission itself; gate it with `authz.require:<perm>` ahead of it (`examples/minimal`
requires `users.manage`) so that only a caller who may manage users learns the role table.
A role name a caller was never meant to have (`constructor`, `toString`, `valueOf`,
`hasOwnProperty`, `__proto__`, …) never resolves to an inherited `Object.prototype` value: role
lookups go through a `Map`, not a plain object index.
Both steps require an attached, booted instance (`kestrel.describe()` from the `attach` hook) for
the permission universe; a `testing/runPipeline` unit test that does not boot must fake or stub
them instead of exercising them directly – see `module.test.ts`'s "wiring error" case and its full
`boot()` tests for the pattern.
Not included: ownership/resource checks (the `resource` argument is ignored), roles stored in a database.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authz-roles` – module `authz/roles`: provides `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `roles` | record | yes | – |
| `roleClaim` | string | no | `"roles"` |
| `anonymous` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable |
|---|---|---|---|---|---|---|---|
| `authz.require:<arg>` | Requires permission <arg> | – | – | – | – | 401 not authenticated; 403 missing permission <arg> | – |
| `authz.describeAccess` | The caller's concrete permissions | `identity` | `result.permissions` | – | { permissions: string[], … } | 401 not authenticated | – |
| `authz.listRoles` | The configured role names, in config order | – | `result.roles` | – | { roles: string[], … } | – | – |
| `authz.validateRoles:<arg>` | Validate the role names at payload.<arg> against the configured roles; an absent value passes. authz.validateRoles:roles reads payload.roles, the shape authn.createUser and authn.updateUser accept | `payload.<arg>` | – | object | – | 400 the value is not an array of known role names | – |

Used by 65 of 83 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
