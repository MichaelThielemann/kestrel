import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz, AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import type { Detach, Introspection, Manifest } from "@michaelthielemann/kestrel";
import { ok, type Result } from "@michaelthielemann/kestrel/result";

export interface Config {
  roles: Record<string, string[]>;
  roleClaim: string;
  anonymous: string[];
}

export interface Access {
  permissions: string[];
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

/** The distinct permissions any booted pipeline requires, read from every `authz.require:<perm>` step. */
export function permissionUniverse(manifest: Manifest): string[] {
  const universe = new Set<string>();
  for (const pipeline of manifest.pipelines) {
    for (const step of pipeline.steps) {
      if (step.name !== "authz.require") continue;
      const colon = step.spec.indexOf(":");
      if (colon !== -1) universe.add(step.spec.slice(colon + 1));
    }
  }
  return [...universe].sort();
}

export interface AuthzRoles extends Authz {
  canAnonymous(permission: string): boolean;
  attach(kestrel: Introspection): Detach;
  describeAccess(identity: Identity): Access;
  listRoles(): string[];
}

export function createAuthzRoles(config: Config): AuthzRoles {
  const roles = new Map(Object.entries(config.roles));
  let universe: string[] | undefined;
  return {
    async can(identity, permission): Promise<Result<boolean, AuthzError>> {
      return ok(rolesOf(identity, config.roleClaim).some((role) => (roles.get(role) ?? []).some((granted) => matches(granted, permission))));
    },
    canAnonymous(permission) {
      return anonymousCan(config, permission);
    },
    attach(kestrel) {
      universe = permissionUniverse(kestrel.describe());
      return () => {
        universe = undefined;
      };
    },
    describeAccess(identity): Access {
      if (!universe) throw new Error("authz/roles: not attached to a booted instance");
      const granted = new Set<string>();
      for (const role of rolesOf(identity, config.roleClaim)) {
        const patterns = roles.get(role) ?? [];
        for (const permission of universe) {
          if (patterns.some((pattern) => matches(pattern, permission))) granted.add(permission);
        }
      }
      return { permissions: [...granted].sort() };
    },
    listRoles(): string[] {
      return [...roles.keys()];
    },
  };
}
