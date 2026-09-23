import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz, AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import type { Detach, Introspection, PipelineManifest } from "@michaelthielemann/kestrel";
import { ok, type Result } from "@michaelthielemann/kestrel/result";

export interface Config {
  roles: Record<string, string[]>;
  roleClaim: string;
  anonymous: string[];
}

export type PipelineVerdict = "granted" | "denied" | "unknown";

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

/** The permissions of one pipeline's `authz.require:<perm>` steps, deduplicated, in step order. Steps inside an atomic group count like any other. */
export function requiredPermissions(pipeline: PipelineManifest): string[] {
  const seen = new Set<string>();
  const permissions: string[] = [];
  for (const step of pipeline.steps) {
    if (step.name !== "authz.require") continue;
    const colon = step.spec.indexOf(":");
    if (colon === -1) continue;
    const permission = step.spec.slice(colon + 1);
    if (seen.has(permission)) continue;
    seen.add(permission);
    permissions.push(permission);
  }
  return permissions;
}

export interface AuthzRoles extends Authz {
  canAnonymous(permission: string): boolean;
  attach(kestrel: Introspection): Detach;
  /** Per booted pipeline: `granted` when the caller passes every `authz.require` step, `denied` when it fails one, `unknown` when the pipeline has none. Without an identity the `anonymous` grants decide, as in `authz.require`. */
  describePipelineAccess(identity: Identity | undefined): Record<string, PipelineVerdict>;
  listRoles(): string[];
}

export function createAuthzRoles(config: Config): AuthzRoles {
  const roles = new Map(Object.entries(config.roles));
  let gates: ReadonlyMap<string, readonly string[]> | undefined;

  function holds(identity: Identity, permission: string): boolean {
    return rolesOf(identity, config.roleClaim).some((role) => (roles.get(role) ?? []).some((granted) => matches(granted, permission)));
  }

  return {
    async can(identity, permission): Promise<Result<boolean, AuthzError>> {
      return ok(holds(identity, permission));
    },
    canAnonymous(permission) {
      return anonymousCan(config, permission);
    },
    attach(kestrel) {
      gates = new Map(kestrel.describe().pipelines.map((p): [string, readonly string[]] => [p.name, requiredPermissions(p)]));
      return () => {
        gates = undefined;
      };
    },
    describePipelineAccess(identity): Record<string, PipelineVerdict> {
      if (!gates) throw new Error("authz/roles: not attached to a booted instance");
      return Object.fromEntries(
        [...gates].map(([name, required]): [string, PipelineVerdict] => {
          if (required.length === 0) return [name, "unknown"];
          const passes = identity ? required.every((permission) => holds(identity, permission)) : required.every((permission) => anonymousCan(config, permission));
          return [name, passes ? "granted" : "denied"];
        }),
      );
    },
    listRoles(): string[] {
      return [...roles.keys()];
    },
  };
}
