import type { Manifest } from "@michaelthielemann/kestrel";
import { defineContract } from "@michaelthielemann/kestrel/defineContract";

export type { Manifest } from "@michaelthielemann/kestrel";

export interface Timing {
  count: number;
  /** Every outcome that is not ok, 4xx included. */
  failed: number;
  /** The 5xx share of `failed`: thrown steps and failures whose status is 500 or above. */
  errors: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PipelineStats extends Timing {
  name: string;
  lastAt: number | null;
}

export interface StepStats extends Timing {
  pipeline: string;
  /** The step spec as written in the pipeline, argument included. */
  step: string;
}

export interface EventStats {
  name: string;
  count: number;
  lastAt: number | null;
}

/** One failed run, as the runner reported it: the message a client would see, never a stack. */
export interface RecentFailure {
  at: number;
  runId: string;
  pipeline: string;
  trigger: { kind: string; name: string };
  status: number;
  ms: number;
  code?: string;
  step?: string;
  message?: string;
}

export interface RateLimitStats {
  key: string;
  remaining: number;
  resetAt: number;
}

/** Numbers of one process since it started; another instance of the same site has its own. */
export interface Stats {
  generatedAt: number;
  process: { pid: number; startedAt: number; uptimeMs: number };
  runs: { active: number; total: number; failed: number; errors: number };
  pipelines: PipelineStats[];
  steps: StepStats[];
  events: EventStats[];
  ratelimit: RateLimitStats[];
  /** The newest failed runs first, capped by the module's ring buffer. */
  recentFailures: RecentFailure[];
}

/** Both methods read process memory only and never fail; `manifest()` is the core's static view, `stats()` the live counters. */
export interface Insights {
  manifest(): Manifest;
  stats(): Stats;
}

export const INSIGHTS = defineContract<Insights>()("insights@1", ["manifest", "stats"]);
