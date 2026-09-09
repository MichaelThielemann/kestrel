import { randomUUID } from "node:crypto";
import { failure, type CoreCode, type KestrelError } from "./errors.ts";
import { err, ok, type Err, type Ok, type Result } from "./result.ts";

export type TriggerKind = "http" | "event" | "cron";

export interface Trigger {
  kind: TriggerKind;
  name: string;
}

declare global {
  namespace Kestrel {
    interface ContextExtensions {}
  }
}

export interface UploadedFile {
  field: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface BinaryResult {
  binary: true;
  data: Uint8Array;
  contentType: string;
  filename?: string;
  headers?: Record<string, string>;
}

export function binaryResult(data: Uint8Array, contentType: string, filename?: string): BinaryResult {
  const result: BinaryResult = { binary: true, data, contentType };
  if (filename !== undefined) result.filename = filename;
  return result;
}

export function isBinaryResult(value: unknown): value is BinaryResult {
  return typeof value === "object" && value !== null && (value as BinaryResult).binary === true && (value as BinaryResult).data instanceof Uint8Array;
}

export interface Context extends Kestrel.ContextExtensions {
  readonly runId: string;
  requestId?: string;
  trigger: Trigger;
  payload: Record<string, unknown>;
  body: Record<string, unknown>;
  query: Record<string, unknown>;
  params: Record<string, string>;
  headers: Record<string, string>;
  files: UploadedFile[];
  ip?: string;
  result?: unknown;
  fail(code: CoreCode, message: string, details?: Record<string, unknown>): Err<KestrelError>;
  fail(error: KestrelError): Err<KestrelError>;
  done(result: unknown): Ok<Context>;
}

export type StepResult = Result<Context, KestrelError>;
export type Step = (ctx: Context) => Promise<StepResult>;
export type StepFactory = (arg: string) => Step;
export type StepMap = Record<string, Step | StepFactory>;

export const DONE = Symbol.for("kestrel.done");

const FACTORY = Symbol.for("kestrel.stepFactory");

/** A Step and a StepFactory are both 1-ary functions; only this brand tells them apart at boot. */
export function stepFactory<F extends StepFactory>(factory: F): F {
  Object.defineProperty(factory, FACTORY, { value: true });
  return factory;
}

export function isStepFactory(fn: unknown): fn is StepFactory {
  return typeof fn === "function" && Reflect.get(fn, FACTORY) === true;
}

export interface ContextInput {
  trigger: Trigger;
  parentRunId?: string;
  payload?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  files?: UploadedFile[];
  ip?: string;
}

export function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** The value is echoed into a response header, so anything but short printable ASCII is dropped. */
const REQUEST_ID = /^[\x20-\x7e]{1,200}$/;

export function requestIdOf(value: unknown): string | undefined {
  const id = first(value);
  return id !== undefined && REQUEST_ID.test(id) ? id : undefined;
}

export function createContext(input: ContextInput, runId: string = randomUUID()): Context {
  const query = input.query ?? {};
  const body = input.body ?? input.payload ?? {};
  const ctx: Context = {
    runId,
    trigger: input.trigger,
    payload: input.payload ?? { ...query, ...body },
    body,
    query,
    params: input.params ?? {},
    headers: input.headers ?? {},
    files: input.files ?? [],
    fail(codeOrError: CoreCode | KestrelError, message?: string, details?: Record<string, unknown>): Err<KestrelError> {
      if (typeof codeOrError !== "string") return err(codeOrError);
      return err(failure(codeOrError, message ?? "", details === undefined ? {} : { details }));
    },
    done(result) {
      const next: Context = { ...this, result };
      Object.defineProperty(next, DONE, { value: true });
      return ok(Object.freeze(next));
    },
  };
  if (input.ip !== undefined) ctx.ip = input.ip;
  const requestId = requestIdOf(input.headers?.["x-request-id"]);
  if (requestId !== undefined) ctx.requestId = requestId;
  return Object.freeze(ctx);
}
