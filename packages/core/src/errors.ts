/**
 * One member per throw-site family in the boot engine (`boot.ts`, `sort.ts`, `dataflow.ts`,
 * `registry.ts`, `load.ts`). Covered by semver from 6.0.0: a minor release may add a code, so code
 * reading it must handle one it does not recognize instead of assuming today's set is complete.
 * `KestrelBootError.reason` and every message text stay uncovered and may change in any release.
 */
export type BootErrorCode =
  | "invalid-config"
  | "module-count"
  | "module-listed-twice"
  | "module-entry-mismatch"
  | "contract-provided-twice"
  | "before-and-requires"
  | "missing-provider"
  | "provides-itself"
  | "dependency-cycle"
  | "module-name-contract"
  | "invalid-module-config"
  | "setup-failed"
  | "missing-methods"
  | "invalid-read-path"
  | "invalid-write-path"
  | "step-not-function"
  | "step-registered-twice"
  | "step-undescribed"
  | "describe-shape"
  | "describe-threw"
  | "describe-unknown-step"
  | "pipeline-defined-twice"
  | "pipeline-empty"
  | "unknown-step"
  | "step-argument"
  | "atomic-unsafe-step"
  | "svg-without-sanitizer"
  | "invalid-allowlist"
  | "unknown-trigger-pipeline"
  | "invalid-trigger"
  | "duplicate-route"
  | "unsatisfied-read"
  | "optional-read-order"
  | "event-hooks-twice"
  | "event-hook-missing"
  | "atomic-scope-twice"
  | "atomic-scope-missing"
  | "undeclared-output"
  | "undeclared-required"
  | "output-fold-contradiction"
  | "terminal-output-misplaced"
  | "attach-failed"
  | "load-failed"
  | "no-default-export"
  | "not-a-module"
  | "not-a-pipeline"
  | "module-unresolved"
  | "config-not-object"
  | "pipelines-not-directory";

export class KestrelBootError extends Error {
  readonly module: string;
  readonly reason: string;
  readonly code: BootErrorCode;

  constructor(module: string, reason: string, code: BootErrorCode) {
    super(`[${module}] ${reason}`);
    this.name = "KestrelBootError";
    this.module = module;
    this.reason = reason;
    this.code = code;
  }
}

export type CoreCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "RATE_LIMITED"
  | "DANGLING_REF"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED"
  | "TRANSIENT"
  | "INTERNAL";

export interface KestrelError<C extends string = string> {
  readonly code: C;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/** The one place a core code becomes an HTTP status. Nothing else maps codes to numbers. */
export const STATUS_OF: Readonly<Record<CoreCode, number>> = {
  VALIDATION: 400,
  DANGLING_REF: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  TRANSIENT: 503,
};

const RETRYABLE: ReadonlySet<CoreCode> = new Set<CoreCode>(["TRANSIENT", "RATE_LIMITED"]);

export interface FailureOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

type Mutable<C extends string> = { -readonly [K in keyof KestrelError<C>]: KestrelError<C>[K] };

export function failure<C extends CoreCode>(code: C, message: string, options: FailureOptions = {}): KestrelError<C> {
  const error: Mutable<C> = { code, status: STATUS_OF[code], message, retryable: RETRYABLE.has(code) };
  if (options.details !== undefined) error.details = options.details;
  if (options.cause !== undefined) error.cause = options.cause;
  return error;
}

/** For codes a contract declares itself; `status` is fixed by the contract file, never at a call site. */
export function customFailure<C extends string>(code: C, status: number, message: string, options: FailureOptions & { retryable?: boolean } = {}): KestrelError<C> {
  const error: Mutable<C> = { code, status, message, retryable: options.retryable ?? false };
  if (options.details !== undefined) error.details = options.details;
  if (options.cause !== undefined) error.cause = options.cause;
  return error;
}

export function isKestrelError(value: unknown): value is KestrelError {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Partial<KestrelError>;
  return typeof error.code === "string" && typeof error.status === "number" && typeof error.message === "string" && typeof error.retryable === "boolean";
}
