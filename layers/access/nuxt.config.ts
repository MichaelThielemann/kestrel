// Authorization (authz) layer — the access guard, policy, CSRF + (later) the grant registry. Split out of
// `auth` (which keeps authentication: session/password/login). Composes AFTER `auth`: the guard verifies the
// session (via auth's `verifySession`/`sessionSettings`) to derive the request principal, then evaluates the
// policy. Keeping authz separate is the seam a future User&Roles extension plugs into.
export default defineNuxtConfig({})
