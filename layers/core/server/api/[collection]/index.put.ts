export default defineEventHandler(async (event) => {
  requireAdmin(event) // write-authorization backstop (defense-in-depth; see require-admin.ts)
  const collection = requireCollection(event)
  const query = getQuery(event)
  const body = await readBody(event)
  const saved = putSingleton(useDb(), collection, query.locale as string | undefined, body, { expectedUpdatedAt: readIfUnmodifiedSince(event) })
  // Awaited, and a rejection is the save's response: a singleton whose write has an external side effect
  // (the redirects artifact the edge serves) is not really saved until that side effect landed, and the
  // write-event bus swallows throws by design. See write-effects.ts.
  try {
    await runWriteEffects(collection.def, saved)
  } catch (error) {
    // The row IS committed and its `updatedAt` bumped, but the client only rebaselines on success — so
    // hand the new baseline back with the error, or the retry these failures ask for would 409 on a
    // precondition that is stale by construction.
    const err = error as { statusCode?: number; statusMessage?: string; data?: Record<string, unknown> }
    throw createError({
      statusCode: err.statusCode ?? 500,
      statusMessage: err.statusMessage ?? 'The record was saved but a follow-up step failed',
      data: { ...(err.data ?? {}), savedUpdatedAt: new Date(saved.updatedAt as string | number).getTime() },
    })
  }
  return saved
})
