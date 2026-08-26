import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { BuiltCollection } from '@michaelthielemann/kestrel-core'
import { TraceCollector } from './trace.js'
import {
  READ_OPS, type ExecPlane, type PipelineContext, type PipelinePorts, type PipelinePrincipal,
  type PipelineRequest, type ReadScope, type RequestFacts,
} from './types.js'

/** @public */
export interface PipelineContextOptions {
  op: string
  collection?: BuiltCollection | null
  db?: BetterSQLite3Database | null
  principal?: PipelinePrincipal | null
  readScope?: ReadScope
  locale?: string
  input?: unknown
  id?: number
  request?: Partial<PipelineRequest>
  /** Whether this run is a read (drives `ctx.exec.read`). Defaults to whether `op` is one of the standard
   *  read ops — a caller that already resolved the pipeline (and so knows a custom `PipelineDef`'s own
   *  `read` flag) passes it explicitly instead. */
  read?: boolean
  event?: H3Event | null
  work?: Record<string, unknown>
  /** Reuse an enclosing run's collector so a nested chain lands in one flat trace. */
  trace?: TraceCollector
}

const NO_REQUEST: PipelineRequest = { ip: '', method: '', headers: {} }

/** @public */
export function createPipelineContext<TIn = unknown, TOut = unknown>(options: PipelineContextOptions): PipelineContext<TIn, TOut> {
  const collection = options.collection ?? null
  const collectionName = collection?.def.name ?? ''
  const facts: RequestFacts = {
    collection: collectionName,
    op: options.op,
    principal: options.principal ?? null,
    readScope: options.readScope ?? 'all',
    locale: options.locale ?? '',
    now: new Date().toISOString(),
    correlationId: randomUUID(),
    causation: Object.freeze({ pipeline: options.op, op: options.op }),
  }
  const ports: PipelinePorts = Object.freeze({
    db: options.db ?? null,
    event: options.event ?? null,
  })
  // Engine plumbing, not step scratch: resolved once here and frozen — a gate or step reads it, nothing
  // ever writes it again.
  const exec: ExecPlane = Object.freeze({
    collection,
    read: options.read ?? READ_OPS.has(options.op),
    request: Object.freeze({ ...NO_REQUEST, ...options.request }),
  })
  const ctx: PipelineContext<TIn, TOut> = {
    input: options.input as TIn,
    facts,
    ports,
    exec,
    output: undefined as TOut,
    work: { ...options.work },
    trace: options.trace ?? new TraceCollector({ pipeline: options.op, collection: collectionName || null, op: options.op }),
  }
  if (options.id !== undefined) ctx.id = options.id
  return ctx
}
