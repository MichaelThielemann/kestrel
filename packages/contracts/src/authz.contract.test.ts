import { describe, it, expect, beforeEach } from "vitest";
import type { Identity } from "./authn.ts";
import type { Authz, Resource } from "./authz.ts";
import { expectOk } from "./testing/result.ts";

export interface AuthzFixture {
  authz: Authz;
  allowed: Identity;
  denied: Identity;
  permission: string;
  ownedResource?: { resource: Resource; owner: Identity; stranger: Identity; permission: string };
}

export function authzContractTests(make: () => Promise<AuthzFixture>) {
  describe("authz@1", () => {
    let f: AuthzFixture;
    beforeEach(async () => {
      f = await make();
    });

    it("grants the permission to the allowed identity", async () => {
      expect(expectOk(await f.authz.can(f.allowed, f.permission))).toBe(true);
    });

    it("denies the permission to the denied identity", async () => {
      expect(expectOk(await f.authz.can(f.denied, f.permission))).toBe(false);
    });

    it("denies unknown permissions without failing", async () => {
      expect(expectOk(await f.authz.can(f.denied, "no.such.permission"))).toBe(false);
    });

    it("accepts a resource argument without failing", async () => {
      expect(expectOk(await f.authz.can(f.allowed, f.permission, { id: "x" }))).toBeTypeOf("boolean");
    });

    it("resource-based decision when the implementation supports it", async () => {
      if (!f.ownedResource) return;
      const { resource, owner, stranger, permission } = f.ownedResource;
      expect(expectOk(await f.authz.can(owner, permission, resource))).toBe(true);
      expect(expectOk(await f.authz.can(stranger, permission, resource))).toBe(false);
    });
  });
}
