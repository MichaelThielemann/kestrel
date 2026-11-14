// eslint-disable-next-line no-restricted-imports -- a target adapter implements the update interface of kestrel-ops
import type { CrashEvent, ReadyProbe, ReleaseSource, StagedDroplet, TargetPreflight } from "@michaelthielemann/kestrel-ops";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";
import type { CfSession } from "./session.ts";

const pending = (step: string): never => {
  throw new OpsError(`kestrel-target-cloudfoundry: ${step} is not implemented`, 2, step);
};

/** The desired and running instances of the app's web process, an active deployment and the health check type, read without refusing. */
export async function preflight(session: CfSession): Promise<TargetPreflight> {
  return pending(`preflight(${session.app})`);
}

/**
 * Uploads `release.dir` as a new package of the app and stages it into a droplet (`cf create-package`, then
 * `cf stage-package`), while the app keeps running; the app's state, droplet and configuration stay as they were,
 * also when staging fails.
 */
export async function stagePackage(session: CfSession, release: ReleaseSource): Promise<StagedDroplet> {
  return pending(`stagePackage(${release.dir})`);
}

/**
 * One readiness check against `readyUrl` once an instance runs: 200 is `ready`; 503, a JSON body with `ready: false`
 * or another 5xx is `not-ready`; 401, 403, 404, a timeout or no connection is `unverifiable`. Without `readyUrl` an
 * instance in state `RUNNING` is `ready`.
 */
export async function probeReady(session: CfSession): Promise<ReadyProbe> {
  return pending(`probeReady(${session.app})`);
}

/** The app's crash events (`audit.app.process.crash` and failed starts) at or after `since`. */
export async function crashEvents(session: CfSession, since: number): Promise<CrashEvent[]> {
  return pending(`crashEvents(${since})`);
}
