import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz, AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import { ok, type Result } from "@michaelthielemann/kestrel/result";

export interface Config {
  roles: Record<string, string[]>;
  roleClaim: string;
  anonymous: string[];
}

export function matches(granted: string, permission: string): boolean {
  if (granted === "*" || granted === permission) return true;
  if (granted.endsWith(".*")) return permission.startsWith(granted.slice(0, -1));
  return false;
}

export function rolesOf(identity: Identity, claim: string): string[] {
  const value = identity.claims[claim];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export function anonymousCan(config: Config, permission: string): boolean {
  return config.anonymous.some((granted) => matches(granted, permission));
}

export interface AuthzRoles extends Authz {
  canAnonymous(permission: string): boolean;
}

export function createAuthzRoles(config: Config): AuthzRoles {
  return {
    async can(identity, permission): Promise<Result<boolean, AuthzError>> {
      return ok(rolesOf(identity, config.roleClaim).some((role) => (config.roles[role] ?? []).some((granted) => matches(granted, permission))));
    },
    canAnonymous(permission) {
      return anonymousCan(config, permission);
    },
  };
}
