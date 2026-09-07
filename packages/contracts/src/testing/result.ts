import { isKestrelError } from "@michaelthielemann/kestrel/errors";
import { expect } from "vitest";
import type { KestrelError, Result } from "../errors.ts";

function describeError(error: unknown): string {
  return isKestrelError(error) ? `${error.code}: ${error.message}` : String(error);
}

export function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected Ok, got Err(${describeError(result.error)})`);
  return result.value;
}

export function expectErr<T, E extends KestrelError>(result: Result<T, E>, code: E["code"]): E {
  if (result.ok) throw new Error(`expected Err(${code}), got Ok(${JSON.stringify(result.value)})`);
  expect(result.error.code).toBe(code);
  return result.error;
}
