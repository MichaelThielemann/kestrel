import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { Identity } from "./authn.ts";
import type { KestrelError, Result } from "./errors.ts";


export type Resource = Record<string, unknown>;

export type AuthzError = KestrelError<"TRANSIENT">;

export interface Authz {
  can(identity: Identity, permission: string, resource?: Resource): Promise<Result<boolean, AuthzError>>;
}

export const AUTHZ = defineContract<Authz>()("authz@1", ["can"]);
