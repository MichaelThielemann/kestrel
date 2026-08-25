// A throwaway fixture consumer for test/e2e/handler-precedence.test.ts — extends the engine at the repo
// root (not a packed tarball; this test is about Nitro's OWN route-precedence rule, not package
// resolution, which scripts/consumer-template-ci.mjs already covers separately) and ships its own
// server/api/[...path].ts, colliding by NAME with layers/core/server/api/[...path].ts.
export default defineNuxtConfig({
  compatibilityDate: '2026-06-02',
  future: { compatibilityVersion: 4 },
  extends: ['../../../..'],
  kestrel: { db: '.data/db.sqlite' },
})
