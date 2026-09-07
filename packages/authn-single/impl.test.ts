import { describe, it, expect } from "vitest";
import { authnContractTests } from "@michaelthielemann/kestrel-contracts/authn.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import { createAuthnSingle, hashPassword, tokenFromHeaders, verifyPassword } from "./impl.ts";
import module from "./module.ts";

const passwordHash = hashPassword("secret");
const config = { username: "admin", passwordHash, sessionTtlSeconds: 60, roles: ["admin"] };

authnContractTests(async () => ({
  authn: createAuthnSingle(config),
  validCredentials: { username: "admin", password: "secret" },
}));

describe("authn/single", () => {
  it("hashes are salted and verifiable", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
    expect(verifyPassword("secret", passwordHash)).toBe(true);
    expect(verifyPassword("Secret", passwordHash)).toBe(false);
  });

  it("rejects a malformed hash at setup", () => {
    expect(() => createAuthnSingle({ ...config, passwordHash: "plain" })).toThrow(/passwordHash must look like/);
  });

  it("rejects wrong username and missing password", async () => {
    const authn = createAuthnSingle(config);
    expect(expectOk(await authn.login({ username: "root", password: "secret" }))).toBeNull();
    expect(expectOk(await authn.login({ username: "admin" }))).toBeNull();
  });

  it("reads the token from bearer header or cookie", () => {
    expect(tokenFromHeaders({ authorization: "Bearer abc" })).toBe("abc");
    expect(tokenFromHeaders({ cookie: "x=1; kestrel_token=abc%20d" })).toBe("abc d");
    expect(tokenFromHeaders({})).toBeUndefined();
  });

  it("matches the bearer scheme case-insensitively", () => {
    expect(tokenFromHeaders({ authorization: "bearer abc" })).toBe("abc");
    expect(tokenFromHeaders({ authorization: "BEARER abc" })).toBe("abc");
    expect(tokenFromHeaders({ authorization: "BeArEr abc" })).toBe("abc");
  });

  it("puts the configured roles into the claims", async () => {
    const session = expectOk(await createAuthnSingle(config).login({ username: "admin", password: "secret" }));
    expect(session?.identity.claims).toEqual({ roles: ["admin"] });
  });

  it("sessions expire", async () => {
    let t = 1_000_000;
    const authn = createAuthnSingle(config, () => t);
    const session = expectOk(await authn.login({ username: "admin", password: "secret" }));
    t += 59_000;
    expect(expectOk(await authn.resolve(session?.token ?? ""))).not.toBeNull();
    t += 2_000;
    expect(expectOk(await authn.resolve(session?.token ?? ""))).toBeNull();
  });
});

const ctx = (headers: Record<string, string> = {}, payload: Record<string, unknown> = {}) => createContext({ trigger: { kind: "http", name: "t" }, headers, payload });

describe("authn/single steps", () => {
  it("login answers UNAUTHENTICATED on wrong credentials and sets token/identity/result on success", async () => {
    const steps = module.steps!(createAuthnSingle(config));
    const error = expectErr(await steps.login(ctx({}, { username: "admin", password: "wrong" })), "UNAUTHENTICATED");
    expect(error.status).toBe(401);
    const loggedIn = await steps.login(ctx({}, { username: "admin", password: "secret" }));
    expect(loggedIn.ok).toBe(true);
    if (loggedIn.ok) {
      expect(loggedIn.value.token).toBeTypeOf("string");
      expect(loggedIn.value.identity.id).toBe("admin");
      expect(loggedIn.value.result).toEqual({ token: loggedIn.value.token, identity: loggedIn.value.identity });
    }
  });

  it("identifyUser never fails: no header leaves the context untouched, a valid token sets identity", async () => {
    const authn = createAuthnSingle(config);
    const steps = module.steps!(authn);
    const untouched = await steps.identifyUser(ctx());
    expect(untouched.ok && untouched.value.identity).toBeUndefined();
    const session = expectOk(await authn.login({ username: "admin", password: "secret" }));
    const identified = await steps.identifyUser(ctx({ authorization: `Bearer ${session?.token}` }));
    expect(identified.ok && identified.value.identity?.id).toBe("admin");
  });

  it("requireUser answers UNAUTHENTICATED without a token and with an unknown token", async () => {
    const steps = module.steps!(createAuthnSingle(config));
    expectErr(await steps.requireUser(ctx()), "UNAUTHENTICATED");
    expectErr(await steps.requireUser(ctx({ authorization: "Bearer no-such-token" })), "UNAUTHENTICATED");
  });

  it("loadIdentity and logout answer UNAUTHENTICATED without a prior requireUser", async () => {
    const steps = module.steps!(createAuthnSingle(config));
    expectErr(await steps.loadIdentity(ctx()), "UNAUTHENTICATED");
    expectErr(await steps.logout(ctx()), "UNAUTHENTICATED");
  });

  it("requireUser then loadIdentity/logout round-trip", async () => {
    const authn = createAuthnSingle(config);
    const steps = module.steps!(authn);
    const session = expectOk(await authn.login({ username: "admin", password: "secret" }));
    const authed = await steps.requireUser(ctx({ authorization: `Bearer ${session?.token}` }));
    expect(authed.ok).toBe(true);
    if (!authed.ok) return;
    const identified = await steps.loadIdentity(authed.value);
    expect(identified.ok && identified.value.result).toEqual(session?.identity);
    const loggedOut = await steps.logout(authed.value);
    expect(loggedOut.ok && loggedOut.value.result).toEqual({ ok: true });
    expect(expectOk(await authn.resolve(session?.token ?? ""))).toBeNull();
  });
});
