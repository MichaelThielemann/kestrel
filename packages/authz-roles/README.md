# authz/roles
`authz@1` with roles from config: `roles: { admin: ["*"], editor: ["pages.*"] }`. The identity's
roles come from `identity.claims[roleClaim]` (default `roles`, string or string[]), set by the
authn module. Permissions are dotted names; `x.*` grants everything below `x`.
`anonymous: ["pages.read"]` lists what a request without identity may do.
Step: `authz.require:<permission>` – passes without identity if `anonymous` grants it, else
`UNAUTHENTICATED`; `FORBIDDEN` when the identity lacks the permission.
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

Used by 54 of 68 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
