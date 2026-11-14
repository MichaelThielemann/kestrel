// eslint-disable-next-line no-restricted-imports -- a target adapter implements the update interface of kestrel-ops
import type { ConfigurationRestore, RecordedConfiguration } from "@michaelthielemann/kestrel-ops";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";
import type { CfSession } from "./session.ts";

const pending = (step: string): never => {
  throw new OpsError(`kestrel-target-cloudfoundry: ${step} is not implemented`, 2, step);
};

/**
 * Reads the app's configuration: environment variables (values of the names in `secretNames` and of the names the
 * manifest entry fills from `vars` only as salted fingerprints), the web process's health check, memory, disk, command
 * and instances, the current droplet and the newest revision.
 */
export async function readConfiguration(session: CfSession, secretNames: ReadonlySet<string>): Promise<RecordedConfiguration> {
  return pending(`readConfiguration(${secretNames.size})`);
}

/**
 * Restores `recorded` verbatim while the app is stopped: plain variables to their values and variables the record
 * does not know removed, through a request body in a file only this user can read, never through a value on a command
 * line; the health check, command, memory and disk of the web process. A secret variable whose current value
 * does not match its fingerprint is reported, not changed.
 */
export async function restoreConfiguration(session: CfSession, recorded: RecordedConfiguration): Promise<ConfigurationRestore> {
  return pending(`restoreConfiguration(${recorded.recordedAt})`);
}
