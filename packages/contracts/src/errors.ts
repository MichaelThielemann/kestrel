// The one import path a contract file needs for the error model: core's Result and KestrelError
// re-exported so contracts never reach into `@michaelthielemann/kestrel/*` twice.
export { failure, customFailure, type CoreCode, type KestrelError } from "@michaelthielemann/kestrel/errors";
export { ok, err, isErr, type Result } from "@michaelthielemann/kestrel/result";
