import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { StepDescription, StepDescriptions } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline, pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { runPipeline, type RunPipelineOptions } from "@michaelthielemann/kestrel/testing/runPipeline";
import { AUTHN_STEPS } from "./authn.steps.ts";
import { FAKE_AUTHN_WRITES } from "./testing/fakeAuthn.ts";

/** The bare step keys of {@link AUTHN_STEPS}, in the shape `writesByStepOf` and each module's own fixture expect. */
export const AUTHN_STEP_KEYS: readonly string[] = AUTHN_STEPS.steps.map((step) => step.slice("authn.".length));

export interface AuthnStepsFixture extends RunPipelineOptions {
  credentials: Record<string, string>;
  /** The session lifetime the module under test was configured with; the session cookie's `Max-Age`. */
  sessionTtlSeconds: number;
  writesByStep: Readonly<Record<string, readonly string[]>>;
}

export function writesByStepOf(prefix: string, describeMap: StepDescriptions, steps: readonly string[]): Record<string, readonly string[]> {
  const entry = (description: StepDescription | ((arg: string) => StepDescription) | undefined): StepDescription => {
    if (description === undefined) throw new Error(`writesByStepOf: no describe() entry for a step of "${prefix}"`);
    return typeof description === "function" ? description("<arg>") : description;
  };
  return Object.fromEntries(steps.map((step) => [`${prefix}.${step}`, entry(describeMap[step]).writes]));
}

const loginPipeline = definePipeline({ name: "login", steps: ["authn.login"] });
const identifyPipeline = definePipeline({ name: "identify", steps: ["authn.identifyUser"] });
const requirePipeline = definePipeline({ name: "require", steps: ["authn.requireUser"] });
const loadIdentityPipeline = definePipeline({ name: "loadIdentity", steps: ["authn.requireUser", "authn.loadIdentity"] });
const logoutPipeline = definePipeline({ name: "logout", steps: ["authn.requireUser", "authn.logout"] });

const EXERCISED = new Set<string>([loginPipeline, identifyPipeline, requirePipeline, loadIdentityPipeline, logoutPipeline].flatMap((p) => pipelineSteps(p.steps)));
for (const step of AUTHN_STEPS.steps) {
  if (!EXERCISED.has(step)) throw new Error(`authnStepsContractTests: no pipeline exercises "${step}"`);
}

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

    it("login hands the token over in an HttpOnly, Secure, SameSite=Strict cookie that lives as long as the session", async () => {
      const { credentials, sessionTtlSeconds, ...options } = await make();
      const loggedIn = await runPipeline(loginPipeline, { body: credentials }, options);
      const token = boundaryCast<{ token: string }>(loggedIn.result, "json").token;
      const cookie = loggedIn.headers?.["set-cookie"] ?? "";
      const [pair, ...attributes] = cookie.split(";").map((part) => part.trim());
      expect(pair).toBe(`kestrel_token=${encodeURIComponent(token)}`);
      expect(attributes).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${sessionTtlSeconds}`]));
    });

    it("logout removes the session cookie", async () => {
      const { credentials, ...options } = await make();
      const loggedIn = await runPipeline(loginPipeline, { body: credentials }, options);
      const token = boundaryCast<{ token: string }>(loggedIn.result, "json").token;
      const out = await runPipeline(logoutPipeline, { headers: { authorization: `Bearer ${token}` } }, options);
      expect(out.status).toBe(200);
      expect(out.headers?.["set-cookie"]).toMatch(/^kestrel_token=;.*Max-Age=0/);
    });

    it("a state-changing request authenticated by the cookie needs same-origin proof, a bearer token does not", async () => {
      const { credentials, ...options } = await make();
      const loggedIn = await runPipeline(loginPipeline, { body: credentials }, options);
      const token = boundaryCast<{ token: string }>(loggedIn.result, "json").token;
      const cookie = `kestrel_token=${encodeURIComponent(token)}`;
      const as = (method: string, headers: Record<string, string>) => ({ trigger: { kind: "http" as const, name: `${method} /things` }, headers });
      for (const pipeline of [requirePipeline, identifyPipeline]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          const refused = await runPipeline(pipeline, as(method, { cookie }), options);
          expect(refused.status, `${pipeline.name} ${method} without proof`).toBe(403);
          expect(refused.code).toBe("FORBIDDEN");
          expect((await runPipeline(pipeline, as(method, { cookie, "sec-fetch-site": "cross-site" }), options)).status).toBe(403);
          expect((await runPipeline(pipeline, as(method, { cookie, "sec-fetch-site": "same-site" }), options)).status).toBe(403);
          expect((await runPipeline(pipeline, as(method, { cookie, origin: "https://elsewhere.example", host: "cms.example" }), options)).status).toBe(403);
          expect((await runPipeline(pipeline, as(method, { cookie, "sec-fetch-site": "same-origin" }), options)).status).toBe(200);
          expect((await runPipeline(pipeline, as(method, { cookie, origin: "https://cms.example", host: "cms.example" }), options)).status).toBe(200);
          expect((await runPipeline(pipeline, as(method, { authorization: `Bearer ${token}` }), options)).status).toBe(200);
        }
        expect((await runPipeline(pipeline, as("GET", { cookie }), options)).status).toBe(200);
      }
    });

    it("declares the same writes as the fake for every step of AUTHN_STEPS", async () => {
      const { writesByStep } = await make();
      for (const step of AUTHN_STEPS.steps) {
        expect(writesByStep[step], `writes for "${step}"`).toEqual(FAKE_AUTHN_WRITES[step]);
      }
    });
  });
}
