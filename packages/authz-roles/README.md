# authz/roles
`authz@1` with roles from config: `roles: { admin: ["*"], editor: ["pages.*"] }`. The identity's
roles come from `identity.claims[roleClaim]` (default `roles`, string or string[]), set by the
authn module. Permissions are dotted names; `x.*` grants everything below `x`.
`anonymous: ["pages.read"]` lists what a request without identity may do.
Step: `authz.require:<permission>` – passes without identity if `anonymous` grants it, else
`UNAUTHENTICATED`; `FORBIDDEN` when the identity lacks the permission.
Step: `authz.describeAccess` – writes `result.permissions` (the caller's roles' patterns expanded
against every permission a booted pipeline requires via `authz.require:<perm>`) and
`result.roles` (the configured role names, in config order). Requires an identity. No client needs
a copy of `roles` or the pattern matcher: `permissions` already lists only concrete, granted names.
Not included: ownership/resource checks (the `resource` argument is ignored), roles stored in a database.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-authz-roles` – module `authz/roles`: provides `authz@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `roles` | record | yes | – |
| `roleClaim` | string | no | `"roles"` |
| `anonymous` | array | no | `[]` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `authz.require:<arg>` | Requires permission <arg> | – | – | – | – | 401 not authenticated; 403 missing permission <arg> |
| `authz.describeAccess` | The caller's concrete permissions and the configured role names | `identity` | `result.permissions`, `result.roles` | – | { permissions: string[], roles: string[], … } | 401 not authenticated |

Used by 64 of 82 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
