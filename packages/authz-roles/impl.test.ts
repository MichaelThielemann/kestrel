import { describe, it, expect } from "vitest";
import { authzContractTests } from "@michaelthielemann/kestrel-contracts/authz.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { anonymousCan, createAuthzRoles, matches } from "./impl.ts";
import module from "./module.ts";

const config = { roles: { admin: ["*"], editor: ["pages.*", "media.read"] }, roleClaim: "roles", anonymous: ["pages.read"] };

authzContractTests(async () => ({
  authz: createAuthzRoles(config),
  allowed: { id: "e", claims: { roles: ["editor"] } },
  denied: { id: "v", claims: { roles: ["visitor"] } },
  permission: "pages.write",
}));

describe("authz/roles", () => {
  it("matches exact, wildcard and prefix permissions", () => {
    expect(matches("*", "anything.at.all")).toBe(true);
    expect(matches("pages.write", "pages.write")).toBe(true);
    expect(matches("pages.*", "pages.write")).toBe(true);
    expect(matches("pages.*", "pagesx.write")).toBe(false);
    expect(matches("pages.write", "pages.read")).toBe(false);
  });

  it("anonymous permissions come from config", () => {
    expect(anonymousCan(config, "pages.read")).toBe(true);
    expect(anonymousCan(config, "pages.write")).toBe(false);
    expect(anonymousCan({ ...config, anonymous: [] }, "pages.read")).toBe(false);
  });

  it("accepts a single role as string and ignores unknown roles", async () => {
    const authz = createAuthzRoles(config);
    expect(expectOk(await authz.can({ id: "a", claims: { roles: "admin" } }, "media.delete"))).toBe(true);
    expect(expectOk(await authz.can({ id: "b", claims: { roles: ["ghost"] } }, "pages.read"))).toBe(false);
    expect(expectOk(await authz.can({ id: "c", claims: {} }, "pages.read"))).toBe(false);
  });

  it("two boots keep their own anonymous config; the first instance is unaffected by a later boot", async () => {
    const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: { step() {}, info() {}, error() {} }, root: process.cwd() };
    const first = await module.setup(module.configSchema.parse({ roles: {}, anonymous: ["pages.read"] }), deps);
    await module.setup(module.configSchema.parse({ roles: {}, anonymous: [] }), deps);
    const require = (module.steps!(first).require as (permission: string) => (ctx: ReturnType<typeof createContext>) => Promise<unknown>)("pages.read");
    await expect(require(createContext({ trigger: { kind: "http", name: "t" } }))).resolves.toBeDefined();
  });
});

const ctx = () => createContext({ trigger: { kind: "http", name: "t" } });
const withIdentity = (identity: { id: string; claims: Record<string, unknown> }) => ({ ...ctx(), identity });

describe("authz/roles steps", () => {
  const authz = createAuthzRoles(config);
  const require = (permission: string) => module.steps!(authz).require(permission);

  it("answers UNAUTHENTICATED without identity when canAnonymous is off", async () => {
    const error = expectErr(await require("pages.write")(ctx()), "UNAUTHENTICATED");
    expect(error.status).toBe(401);
  });

  it("passes without identity when canAnonymous grants the permission", async () => {
    expectOk(await require("pages.read")(ctx()));
  });

  it("answers FORBIDDEN when the identity lacks the permission", async () => {
    const error = expectErr(await require("pages.write")(withIdentity({ id: "v", claims: { roles: ["visitor"] } })), "FORBIDDEN");
    expect(error.status).toBe(403);
  });

  it("passes when the identity has the permission", async () => {
    expectOk(await require("pages.write")(withIdentity({ id: "e", claims: { roles: ["editor"] } })));
  });
});
