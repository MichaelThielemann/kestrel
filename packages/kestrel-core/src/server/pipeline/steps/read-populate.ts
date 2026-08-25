import { Effect } from 'effect'
import { populateRow, resolveBudgetFor, withResolveScope } from '@kestrel/core'
import { collectionOf, type Row } from './shared.js'
import type { ParsedListQuery } from './read-parse-query.js'
import { clampDepth, publicOnlyOf, type ListResult } from './read-shared.js'
import { syncStep, type StepDef } from '../types.js'

/** The populate-scope fail-closed property (`publicOnly`) lives here, not in `fetch` — SEALED for the same
 * @public
 *  reason: it is the one place a public-scope read is kept from expanding a reference past the public set. */
export function populateManyStep(): StepDef {
  return syncStep('populate', (ctx) => Effect.sync(() => {
    const c = collectionOf(ctx)
    const parsed = ctx.work.parsedQuery as ParsedListQuery
    const publicOnly = publicOnlyOf(ctx)
    const result = ctx.output as ListResult
    // One resolve scope per request: repeated refs across the page's rows resolve once, and the DISTINCT
    // fan-out is budgeted — an anonymous `?depth=10&perPage=500` read can no longer multiply into an
    // unbounded number of synchronous DB reads (each blocks the single event-loop thread).
    result.data = withResolveScope(
      () => result.data.map((r) => populateRow(r, { depth: parsed.depth, locale: parsed.populateLocale, def: c.def, publicOnly })),
      resolveBudgetFor(parsed.perPage), // scale the ceiling with the page size so a full legitimate page always populates
      `list ${c.def.name}`,
    ) as Row[]
  }), {
    sealed: true,
    // `populateRow` itself no-ops at depth <= 0; declaring it here too makes that skip visible in the trace.
    when: (ctx) => (ctx.work.parsedQuery as ParsedListQuery).depth > 0,
    whenLabel: 'depth > 0',
  })
}

/** @public */
export function populateOneStep(): StepDef {
  return syncStep('populate', (ctx) => Effect.sync(() => {
    if (ctx.work.notFound) { ctx.output = null; return }
    const c = collectionOf(ctx)
    const row = ctx.work.row as Row
    const depth = clampDepth((ctx.input as { depth?: unknown } | undefined)?.depth)
    const locale = ctx.work.locale as string
    const publicOnly = publicOnlyOf(ctx)
    const label = ctx.id === undefined ? `singleton ${c.def.name}` : `get ${c.def.name}:${ctx.id}`
    // Nested reads (the relation populator's recursive getOne) reuse the enclosing request's scope.
    ctx.output = withResolveScope(
      () => populateRow(row, { depth, locale, def: c.def, publicOnly }),
      resolveBudgetFor(1),
      label,
    )
  }), { sealed: true })
}
