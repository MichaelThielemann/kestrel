import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import type { UpdateContext } from "./types.ts";
import { notImplemented } from "./pending.ts";

/**
 * The storages of the release's modules: the `storage` export of every module package installed for the release
 * (from the project on this machine, or from the bundle in a deploy job), in the order `orderStorages` gives.
 */
export async function releaseStorages(ctx: UpdateContext): Promise<ModuleStorage[]> {
  return notImplemented(`releaseStorages(${ctx.release.dir})`);
}
