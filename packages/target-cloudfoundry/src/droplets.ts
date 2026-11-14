// eslint-disable-next-line no-restricted-imports -- a target adapter implements the update interface of kestrel-ops
import type { DropletInfo, RevisionInfo } from "@michaelthielemann/kestrel-ops";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";
import type { CfSession } from "./session.ts";

const pending = (step: string): never => {
  throw new OpsError(`kestrel-target-cloudfoundry: ${step} is not implemented`, 2, step);
};

/** Every droplet of the app, oldest first, marking the current one. */
export async function listDroplets(session: CfSession): Promise<DropletInfo[]> {
  return pending(`listDroplets(${session.app})`);
}

/** Every revision of the app, oldest first, with the droplet each names. */
export async function listRevisions(session: CfSession): Promise<RevisionInfo[]> {
  return pending(`listRevisions(${session.app})`);
}

/** Deletes droplet `guid` of the app; refuses with exit 1 for the current droplet or one of another app. */
export async function deleteDroplet(session: CfSession, guid: string): Promise<void> {
  return pending(`deleteDroplet(${guid})`);
}

/** Downloads the bits of droplet `guid` into `file`; false when the platform does not hand them out. */
export async function saveDroplet(session: CfSession, guid: string, file: string): Promise<boolean> {
  return pending(`saveDroplet(${guid}, ${file})`);
}

/** Uploads droplet bits saved by {@link saveDroplet} as a new droplet of the app and resolves to its guid. */
export async function restoreDroplet(session: CfSession, file: string): Promise<string> {
  return pending(`restoreDroplet(${file})`);
}
