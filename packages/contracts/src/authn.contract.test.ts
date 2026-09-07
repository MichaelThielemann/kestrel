import { describe, it, expect, beforeEach } from "vitest";
import type { Authn } from "./authn.ts";
import { expectOk } from "./testing/result.ts";

export interface AuthnFixture {
  authn: Authn;
  validCredentials: Record<string, string>;
}

export function authnContractTests(make: () => Promise<AuthnFixture>) {
  describe("authn@1", () => {
    let f: AuthnFixture;
    beforeEach(async () => {
      f = await make();
    });

    it("login with valid credentials returns a session with token and identity", async () => {
      const session = expectOk(await f.authn.login(f.validCredentials));
      expect(session).not.toBeNull();
      expect(typeof session?.token).toBe("string");
      expect(session?.token.length).toBeGreaterThan(0);
      expect(typeof session?.identity.id).toBe("string");
      expect(session?.identity.claims).toBeTypeOf("object");
    });

    it("login with wrong credentials returns null and does not fail", async () => {
      const wrong = Object.fromEntries(Object.keys(f.validCredentials).map((k) => [k, "definitely-wrong"]));
      expect(expectOk(await f.authn.login(wrong))).toBeNull();
    });

    it("login with empty credentials returns null", async () => {
      expect(expectOk(await f.authn.login({}))).toBeNull();
    });

    it("resolve of a session token returns the identity", async () => {
      const session = expectOk(await f.authn.login(f.validCredentials));
      const identity = expectOk(await f.authn.resolve(session?.token ?? ""));
      expect(identity).toEqual(session?.identity);
    });

    it("two logins yield different tokens", async () => {
      const a = expectOk(await f.authn.login(f.validCredentials));
      const b = expectOk(await f.authn.login(f.validCredentials));
      expect(a?.token).not.toBe(b?.token);
    });

    it("resolve of an unknown token returns null", async () => {
      expect(expectOk(await f.authn.resolve("no-such-token"))).toBeNull();
    });

    it("logout invalidates the token", async () => {
      const session = expectOk(await f.authn.login(f.validCredentials));
      const token = session?.token ?? "";
      expectOk(await f.authn.logout(token));
      expect(expectOk(await f.authn.resolve(token))).toBeNull();
    });

    it("logout of an unknown token is ok", async () => {
      expect(expectOk(await f.authn.logout("no-such-token"))).toBeUndefined();
    });
  });
}
