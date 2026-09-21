import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { runPipeline, type RunPipelineOptions } from "@michaelthielemann/kestrel/testing/runPipeline";

export interface AuthnStepsFixture extends RunPipelineOptions {
  credentials: Record<string, string>;
}

const loginPipeline = definePipeline({ name: "login", steps: ["authn.login"] });
const identifyPipeline = definePipeline({ name: "identify", steps: ["authn.identifyUser"] });
const requirePipeline = definePipeline({ name: "require", steps: ["authn.requireUser"] });
const loadIdentityPipeline = definePipeline({ name: "loadIdentity", steps: ["authn.requireUser", "authn.loadIdentity"] });
const logoutPipeline = definePipeline({ name: "logout", steps: ["authn.requireUser", "authn.logout"] });

/** Shared behaviour of the five steps authn-single and authn-multi both register: login, identifyUser, requireUser, loadIdentity, logout. */
export function authnStepsContractTests(make: () => Promise<AuthnStepsFixture>) {
  describe("authn@1 steps", () => {
    it("login, identifyUser, requireUser, loadIdentity and logout round-trip, and requireUser fails after logout", async () => {
      const { credentials, ...options } = await make();
      const loggedIn = await runPipeline(loginPipeline, { body: credentials }, options);
      expect(loggedIn.status).toBe(200);
      const token = boundaryCast<{ token: string }>(loggedIn.result, "json").token;
      const headers = { authorization: `Bearer ${token}` };

      expect((await runPipeline(identifyPipeline, { headers }, options)).status).toBe(200);
      expect((await runPipeline(requirePipeline, { headers }, options)).status).toBe(200);
      expect((await runPipeline(loadIdentityPipeline, { headers }, options)).status).toBe(200);
      expect((await runPipeline(logoutPipeline, { headers }, options)).status).toBe(200);
      expect((await runPipeline(requirePipeline, { headers }, options)).status).toBe(401);
    });

    it("login answers 401 UNAUTHENTICATED on wrong credentials", async () => {
      const { credentials, ...options } = await make();
      const wrong = Object.fromEntries(Object.keys(credentials).map((key) => [key, "definitely-wrong"]));
      const res = await runPipeline(loginPipeline, { body: wrong }, options);
      expect(res.status).toBe(401);
      expect(res.code).toBe("UNAUTHENTICATED");
    });

    it("requireUser answers 401 without a token, identifyUser answers ok without one", async () => {
      const fixture = await make();
      expect((await runPipeline(requirePipeline, {}, fixture)).status).toBe(401);
      expect((await runPipeline(identifyPipeline, {}, fixture)).status).toBe(200);
    });

    it("requireUser and identifyUser answer 401/ok on an unknown bearer token", async () => {
      const fixture = await make();
      const headers = { authorization: "Bearer no-such-token" };
      expect((await runPipeline(requirePipeline, { headers }, fixture)).status).toBe(401);
      const identified = await runPipeline(identifyPipeline, { headers }, fixture);
      expect(identified.status).toBe(200);
    });
  });
}
