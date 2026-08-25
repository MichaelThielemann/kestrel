// Same file path as layers/core/server/api/[...path].ts — see test/e2e/handler-precedence.test.ts.
export default defineEventHandler(() => ({ marker: 'consumer-owned-handler' }))
