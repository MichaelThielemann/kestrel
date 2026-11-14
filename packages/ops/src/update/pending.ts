import { OpsError } from "../errors.ts";

/** Throws the error of an update step this build does not implement, naming the step; exit code 2. */
export function notImplemented(step: string): never {
  throw new OpsError(`kestrel-ops update: ${step} is not implemented`, 2, step);
}
