/** @public */
export type StepStatus = 'ok' | 'skipped-condition' | 'error'

/** @public */
export type StepPhase = 'main' | 'after'

/** @public */
export interface GateTraceEntry {
  gate: string
  passed: boolean
  detail?: string
}

/** @public */
export interface StepTraceEntry {
  name: string
  phase: StepPhase
  status: StepStatus
  ms: number
  /** Why the step was skipped, or what failed. */
  reason?: string
  critical?: boolean
  annotations?: Record<string, unknown>
}

/** @public */
export interface PipelineTrace {
  pipeline: string
  collection: string | null
  op: string
  gates: GateTraceEntry[]
  steps: StepTraceEntry[]
  ms: number
}

/** @public */
export interface TraceMeta {
  pipeline: string
  collection?: string | null
  op: string
}

/** Collects one run's gate outcomes and per-step entries. Dependency-free and JSON-serializable so a
 * @public
 *  route can embed it verbatim. */
export class TraceCollector {
  private readonly meta: TraceMeta
  private readonly gates: GateTraceEntry[] = []
  private readonly steps: StepTraceEntry[] = []
  private readonly startedAt = now()
  private current: StepTraceEntry | null = null

  constructor(meta: TraceMeta) {
    this.meta = meta
  }

  gate(gate: string, passed: boolean, detail?: string): void {
    this.gates.push(detail === undefined ? { gate, passed } : { gate, passed, detail })
  }

  /** Opens a step entry and returns its closer. The entry is appended immediately so annotations
   *  written by the running step land on it. */
  beginStep(name: string, phase: StepPhase, critical?: boolean): (status: StepStatus, reason?: string) => void {
    const entry: StepTraceEntry = { name, phase, status: 'ok', ms: 0 }
    if (critical !== undefined) entry.critical = critical
    const startedAt = now()
    this.steps.push(entry)
    this.current = entry
    return (status, reason) => {
      entry.status = status
      entry.ms = round(now() - startedAt)
      if (reason !== undefined) entry.reason = reason
      if (this.current === entry) this.current = null
    }
  }

  /** Annotate the step currently running; a no-op outside a step. */
  annotate(key: string, value: unknown): void {
    if (!this.current) return
    this.current.annotations ??= {}
    this.current.annotations[key] = value
  }

  toJSON(): PipelineTrace {
    return {
      pipeline: this.meta.pipeline,
      collection: this.meta.collection ?? null,
      op: this.meta.op,
      gates: [...this.gates],
      steps: this.steps.map((s) => ({ ...s })),
      ms: round(now() - this.startedAt),
    }
  }
}

function now(): number {
  return performance.now()
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000
}
