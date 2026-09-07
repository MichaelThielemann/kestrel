import { describe, it, expect } from "vitest";
import { authnContractTests } from "@michaelthielemann/kestrel-contracts/authn.contract.test";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Result } from "@michaelthielemann/kestrel/result";
import { createAuthnMulti, hashPassword, tokenFromHeaders, SESSIONS, USERS } from "./impl.ts";
import module from "./module.ts";

const config = { identifier: "username" as const, minPasswordLength: 8, sessionTtlSeconds: 60 };

authnContractTests(async () => {
  const authn = await createAuthnMulti(config, createFakePersistence());
  expectOk(await authn.createUser({ username: "alice", password: "secret-123", roles: ["editor"] }));
  return { authn, validCredentials: { username: "alice", password: "secret-123" } };
});

describe("authn/multi", () => {
  it("bootstraps the first user only when the collection is empty", async () => {
    const db = createFakePersistence();
    const bootstrap = { username: "admin", passwordHash: hashPassword("bootstrap-pw"), roles: ["admin"] };
    const a = await createAuthnMulti({ ...config, bootstrap }, db);
    expect(expectOk(await a.listUsers()).map((u) => u.username)).toEqual(["admin"]);
    const session = expectOk(await a.login({ username: "admin", password: "bootstrap-pw" }));
    expect(session?.identity.claims).toEqual({ username: "admin", roles: ["admin"] });
    await createAuthnMulti({ ...config, bootstrap: { ...bootstrap, username: "again" } }, db);
    expect(expectOk(await db.count(USERS, {}))).toBe(1);
  });

  it("enforces unique usernames and password length", async () => {
    const a = await createAuthnMulti(config, createFakePersistence());
    expectOk(await a.createUser({ username: "bob", password: "long-enough" }));
    expectErr(await a.createUser({ username: "bob", password: "long-enough" }), "CONFLICT");
    expectErr(await a.createUser({ username: "eve", password: "short" }), "VALIDATION");
    const race = await Promise.all([a.createUser({ username: "race", password: "long-enough" }), a.createUser({ username: "race", password: "long-enough" })]);
    expect(race.filter((r) => r.ok)).toHaveLength(1);
    const lost = race.find((r) => !r.ok);
    expect(lost && !lost.ok ? lost.error : null).toMatchObject({ code: "CONFLICT", message: 'authn/multi: user "race" already exists' });
  });

  it("never exposes password hashes", async () => {
    const a = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await a.createUser({ username: "bob", password: "long-enough" }));
    expect(user).not.toHaveProperty("passwordHash");
    expect(expectOk(await a.listUsers())[0]).not.toHaveProperty("passwordHash");
  });

  it("setPassword invalidates sessions, changePassword needs the current one", async () => {
    const a = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await a.createUser({ username: "bob", password: "long-enough" }));
    const session = expectOk(await a.login({ username: "bob", password: "long-enough" }));
    expectOk(await a.setPassword(user.id, "another-one"));
    expect(expectOk(await a.resolve(session?.token ?? ""))).toBeNull();
    expectErr(await a.changePassword(user.id, "wrong", "third-pass"), "VALIDATION");
    expectOk(await a.changePassword(user.id, "another-one", "third-pass"));
    expect(expectOk(await a.login({ username: "bob", password: "third-pass" }))).not.toBeNull();
  });

  it("changePassword ends every other session but keeps the current one", async () => {
    const a = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await a.createUser({ username: "bob", password: "long-enough" }));
    const mine = expectOk(await a.login({ username: "bob", password: "long-enough" }));
    const other = expectOk(await a.login({ username: "bob", password: "long-enough" }));
    expectOk(await a.changePassword(user.id, "long-enough", "another-one", mine?.token));
    expect(expectOk(await a.resolve(mine?.token ?? ""))).not.toBeNull();
    expect(expectOk(await a.resolve(other?.token ?? ""))).toBeNull();
    expectOk(await a.changePassword(user.id, "another-one", "third-pass"));
    expect(expectOk(await a.resolve(mine?.token ?? ""))).toBeNull();
  });

  it("deactivated users cannot log in and lose their sessions", async () => {
    const a = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await a.createUser({ username: "bob", password: "long-enough" }));
    const session = expectOk(await a.login({ username: "bob", password: "long-enough" }));
    expectOk(await a.setActive(user.id, false));
    expect(expectOk(await a.resolve(session?.token ?? ""))).toBeNull();
    expect(expectOk(await a.login({ username: "bob", password: "long-enough" }))).toBeNull();
    expectOk(await a.setActive(user.id, true));
    expect(expectOk(await a.login({ username: "bob", password: "long-enough" }))).not.toBeNull();
  });

  it("sessions expire and cleanup removes them", async () => {
    let t = 1_000_000;
    const db = createFakePersistence();
    const a = await createAuthnMulti(config, db, () => t);
    expectOk(await a.createUser({ username: "bob", password: "long-enough" }));
    const session = expectOk(await a.login({ username: "bob", password: "long-enough" }));
    t += 61_000;
    expect(expectOk(await a.cleanupSessions())).toBe(1);
    expect(expectOk(await db.count(SESSIONS, {}))).toBe(0);
    expect(expectOk(await a.resolve(session?.token ?? ""))).toBeNull();
  });

  it("reads the token from the bearer header case-insensitively, or from the cookie", () => {
    expect(tokenFromHeaders({ authorization: "Bearer abc" })).toBe("abc");
    expect(tokenFromHeaders({ authorization: "bearer abc" })).toBe("abc");
    expect(tokenFromHeaders({ authorization: "BEARER abc" })).toBe("abc");
    expect(tokenFromHeaders({ cookie: "x=1; kestrel_token=abc%20d" })).toBe("abc d");
    expect(tokenFromHeaders({})).toBeUndefined();
  });

  it("uses email as identifier when configured", async () => {
    const a = await createAuthnMulti({ ...config, identifier: "email" }, createFakePersistence());
    expectOk(await a.createUser({ username: "bob@example.org", password: "long-enough" }));
    expect(expectOk(await a.login({ email: "bob@example.org", password: "long-enough" }))).not.toBeNull();
    expect(expectOk(await a.login({ username: "bob@example.org", password: "long-enough" }))).toBeNull();
  });
});

const ctx = (overrides: { payload?: Record<string, unknown>; params?: Record<string, string>; headers?: Record<string, string> } = {}) =>
  createContext({ trigger: { kind: "http", name: "t" }, payload: overrides.payload ?? {}, params: overrides.params ?? {}, headers: overrides.headers ?? {} });

describe("authn/multi module steps", () => {
  it("login: UNAUTHENTICATED on wrong credentials, ok on right ones", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
    const login = module.steps!(authn).login;
    expectErr(await login(ctx({ payload: { username: "bob", password: "wrong" } })), "UNAUTHENTICATED");
    const step = expectOk(await login(ctx({ payload: { username: "bob", password: "long-enough" } })));
    expect(typeof step.token).toBe("string");
    expect(step.identity).toMatchObject({ claims: { username: "bob" } });
  });

  it("requireUser: UNAUTHENTICATED without a valid token, ok with one", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
    const login = module.steps!(authn).login;
    const requireUser = module.steps!(authn).requireUser;
    expectErr(await requireUser(ctx()), "UNAUTHENTICATED");
    expectErr(await requireUser(ctx({ headers: { authorization: "Bearer nope" } })), "UNAUTHENTICATED");
    const session = expectOk(await login(ctx({ payload: { username: "bob", password: "long-enough" } })));
    const step = expectOk(await requireUser(ctx({ headers: { authorization: `Bearer ${session.token}` } })));
    expect(step.identity).toMatchObject({ claims: { username: "bob" } });
  });

  it("createUser: CONFLICT on a duplicate username, ok otherwise", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    const createUser = module.steps!(authn).createUser;
    expectOk(await createUser(ctx({ payload: { username: "bob", password: "long-enough" } })));
    expectErr(await createUser(ctx({ payload: { username: "bob", password: "long-enough" } })), "CONFLICT");
  });

  it("getUser: NOT_FOUND for an unknown id, ok for a known one", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
    const getUser = module.steps!(authn).getUser;
    expectErr(await getUser(ctx({ params: { id: "nope" } })), "NOT_FOUND");
    expectOk(await getUser(ctx({ params: { id: user.id } })));
  });

  it("deactivateUser: VALIDATION for self, NOT_FOUND for an unknown id, ok otherwise", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
    const deactivateUser = module.steps!(authn).deactivateUser;
    const asSelf = { ...ctx({ params: { id: user.id } }), identity: { id: user.id, claims: {} } };
    expectErr(await deactivateUser(asSelf), "VALIDATION");
    expectErr(await deactivateUser(ctx({ params: { id: "nope" } })), "NOT_FOUND");
    expectOk(await deactivateUser(ctx({ params: { id: user.id } })));
  });

  it("activateUser: NOT_FOUND for an unknown id, ok for a known one", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
    const activateUser = module.steps!(authn).activateUser;
    expectErr(await activateUser(ctx({ params: { id: "nope" } })), "NOT_FOUND");
    expectOk(await activateUser(ctx({ params: { id: user.id } })));
  });

  it("changePassword: UNAUTHENTICATED without identity, VALIDATION on missing fields", async () => {
    const authn = await createAuthnMulti(config, createFakePersistence());
    const user = expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
    const changePassword = module.steps!(authn).changePassword;
    expectErr(await changePassword(ctx({ payload: { currentPassword: "long-enough", newPassword: "another-one" } })), "UNAUTHENTICATED");
    const withIdentity = { ...ctx({ payload: {} }), identity: { id: user.id, claims: {} } };
    expectErr(await changePassword(withIdentity), "VALIDATION");
  });

  describe("setPassword step", () => {
    it("NOT_FOUND for an unknown user, VALIDATION for a short password, ok for a valid one", async () => {
      const authn = await createAuthnMulti(config, createFakePersistence());
      const user = expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
      const setPassword = module.steps!(authn).setPassword;
      const payload = (id: string, password: string) => ctx({ params: { id }, payload: { password } });
      expectErr(await setPassword(payload("nope", "long-enough-2")), "NOT_FOUND");
      expectErr(await setPassword(payload(user.id, "short")), "VALIDATION");
      const step = expectOk(await setPassword(payload(user.id, "long-enough-2")));
      expect(step.result).toMatchObject({ ok: true });
    });
  });

  it("every contract-backed step propagates a transient persistence failure as a retryable 503", async () => {
    const db = createFakePersistence();
    const authn = await createAuthnMulti(config, db);
    const steps = module.steps!(authn);
    const calls: Array<() => Promise<Result<Context, KestrelError>>> = [
      () => steps.login(ctx({ payload: { username: "bob", password: "long-enough" } })),
      () => steps.identifyUser(ctx({ headers: { authorization: "Bearer sometoken" } })),
      () => steps.requireUser(ctx({ headers: { authorization: "Bearer sometoken" } })),
      () => steps.logout({ ...ctx(), token: "sometoken" }),
      () => steps.createUser(ctx({ payload: { username: "carol", password: "long-enough" } })),
      () => steps.listUsers(ctx()),
      () => steps.getUser(ctx({ params: { id: "someid" } })),
      () => steps.setPassword(ctx({ params: { id: "someid" }, payload: { password: "long-enough" } })),
      () => steps.changePassword({ ...ctx({ payload: { currentPassword: "a", newPassword: "long-enough" } }), identity: { id: "someid", claims: {} } }),
      () => steps.deactivateUser(ctx({ params: { id: "someid" } })),
      () => steps.activateUser(ctx({ params: { id: "someid" } })),
      () => steps.cleanupSessions(ctx()),
    ];

    for (const call of calls) {
      db.failNext("TRANSIENT");
      const error = expectErr(await call(), "TRANSIENT");
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
    }
  });
});
