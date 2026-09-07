# authz/roles
`authz@1` with roles from config: `roles: { admin: ["*"], editor: ["pages.*"] }`. The identity's
roles come from `identity.claims[roleClaim]` (default `roles`, string or string[]), set by the
authn module. Permissions are dotted names; `x.*` grants everything below `x`.
`anonymous: ["pages.read"]` lists what a request without identity may do.
Step: `authz.require:<permission>` – passes without identity if `anonymous` grants it, else
`UNAUTHENTICATED`; `FORBIDDEN` when the identity lacks the permission.
Not included: ownership/resource checks (the `resource` argument is ignored), roles stored in a database.
