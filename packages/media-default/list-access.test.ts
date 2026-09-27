import { describe, expect, it } from "vitest";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import { AUTHZ, type Authz } from "@michaelthielemann/kestrel-contracts/authz";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import module, { configSchema } from "./module.ts";

function blobstore(): Blobstore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, data) { blobs.set(key, data); return ok(); },
    async get(key) { return ok(blobs.get(key) ?? null); },
    async remove(key) { blobs.delete(key); return ok(); },
    async move(from, to) { const b = blobs.get(from); if (b) { blobs.set(to, b); blobs.delete(from); } return ok(); },
    async list(prefix) { return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.byteLength }))); },
  };
}

const rolesAuthz: Authz = {
  async can(identity, permission) {
    const roles = Array.isArray(identity.claims.roles) ? identity.claims.roles : [];
    return ok(permission === "media.list" && roles.includes("editor"));
  },
};

async function steps(withAuthz: boolean) {
  const providers = new Map<string, unknown>([[BLOBSTORE.name, blobstore()], [PERSISTENCE.name, createFakePersistence()], ...(withAuthz ? [[AUTHZ.name, rolesAuthz] as [string, unknown]] : [])]);
  const instance = await module.setup(configSchema.parse({}), {
    get<T>(contract: Contract<T>): T {
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  });
  return module.steps!(instance);
}

const as = (identity: Identity | undefined, payload: Record<string, unknown> = {}): Context => {
  const ctx = createContext({ trigger: { kind: "http", name: "t" }, payload });
  return identity === undefined ? ctx : { ...ctx, identity };
};

const ROLELESS: Identity = { id: "nobody", claims: { roles: [] } };
const EDITOR: Identity = { id: "ed", claims: { roles: ["editor"] } };

describe("media/default listing the library", () => {
  it("refuses an account without the list permission with 403, for the library and its folders", async () => {
    const s = await steps(true);
    expect(expectErr(await s.list(as(ROLELESS)), "FORBIDDEN").status).toBe(403);
    expect(expectErr(await s.listFolders(as(ROLELESS)), "FORBIDDEN").status).toBe(403);
  });

  it("lists for an account holding the permission", async () => {
    const s = await steps(true);
    expectOk(await s.list(as(EDITOR)));
    expectOk(await s.listFolders(as(EDITOR)));
  });

  it("still serves any caller media by id", async () => {
    const s = await steps(true);
    expectOk(await s.list(as(ROLELESS, { ids: "a,b" })));
    expectOk(await s.list(as(undefined, { ids: "a,b" })));
  });

  it("keeps refusing an anonymous caller with 401", async () => {
    const s = await steps(true);
    expectErr(await s.list(as(undefined)), "UNAUTHENTICATED");
    expectErr(await s.listFolders(as(undefined)), "UNAUTHENTICATED");
  });

  it("lets any signed-in caller list when no authz module is loaded", async () => {
    const s = await steps(false);
    expectOk(await s.list(as(ROLELESS)));
    expectOk(await s.listFolders(as(ROLELESS)));
  });
});
