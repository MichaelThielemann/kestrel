import { defineContract } from "@michaelthielemann/kestrel/defineContract";

export interface Problem {
  path: string;
  message: string;
}

export interface Validation {
  ok: boolean;
  problems: Problem[];
}

export interface Validate {
  /** Every target this provider has a schema for, `"<collection>.<field>"`. */
  targets(): string[];
  /** `null` means absent — callers skip it instead of checking it. */
  check(target: string, value: unknown): Validation;
}

export const VALIDATE = defineContract<Validate>()("validate@1", ["targets", "check"]);
