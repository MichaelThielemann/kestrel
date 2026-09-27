import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot as bootKestrel, defineModule } from "@michaelthielemann/kestrel";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { clientKey, createRateLimitMemory, usernameKey } from "./impl.ts";
import module from "./module.ts";

const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: silentLogger, root: process.cwd(), eventTriggers: [] };

const buckets = {
  login: { limit: 5, windowSeconds: 60 },
  loginAccount: { limit: 10, windowSeconds: 300, key: "username" as const, maxBlockSeconds: 900 },
  changePassword: { limit: 5, windowSeconds: 300, key: "identity" as const },
};

async function boot() {
  return module.setup(module.configSchema.parse({ buckets }), deps);
}

const login = definePipeline({ name: "login", steps: ["ratelimit.check:login", "ratelimit.check:loginAccount"] });
const accountOnly = definePipeline({ name: "loginAccount", steps: ["ratelimit.check:loginAccount"] });
const IDENTIFY: Record<string, Step> = { "test.identify": async (ctx: Context) => ok({ ...ctx, identity: { id: "victim", claims: {} } }) };
const changePassword = definePipeline({ name: "changePassword", steps: ["test.identify", "ratelimit.check:changePassword"] });

describe("ratelimit/memory keys", () => {
  it("counts every address of one IPv6 /64 as one client", () => {
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe(clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(clientKey("2001:db8:1:2::1")).not.toBe(clientKey("2001:db8:1:3::1"));
    expect(clientKey("2001:0DB8:0001:0002::")).toBe(clientKey("2001:db8:1:2::9"));
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey(undefined)).toBe("unknown");
  });

  it("refuses 1000 attempts from one /64 against one account once the account limit is reached", async () => {
    const instance = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const ip = `2001:db8:5:6:${(i % 65536).toString(16)}:${(i >> 4).toString(16)}::1`;
      statuses.push((await runPipeline(accountOnly, { ip, body: { username: "Victim" } }, { modules: [{ module, instance }] })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
  });

  it("limits a whole IPv6 /64 as one client, whichever accounts it tries", async () => {
    const instance = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await runPipeline(login, { ip: `2001:db8:7:8::${(i + 1).toString(16)}`, body: { username: `user-${i}` } }, { modules: [{ module, instance }] })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it("stops attempts from many IPv4 addresses against one account at the account limit, whatever the spelling of the name", async () => {
    const instance = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const username = i % 2 === 0 ? "victim" : "  VICTIM ";
      statuses.push((await runPipeline(login, { ip: `198.51.100.${i}`, body: { username } }, { modules: [{ module, instance }] })).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(10);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
    expect((await runPipeline(login, { ip: "198.51.100.200", body: { username: "someone-else" } }, { modules: [{ module, instance }] })).status).toBe(200);
  });

  it("limits password checks per signed-in identity, whatever address they come from", async () => {
    const instance = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await runPipeline(changePassword, { ip: `203.0.113.${i}` }, { modules: [{ module, instance }], steps: IDENTIFY, writes: { "test.identify": ["identity"] } })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
  });

  it("blocks an account for a growing time after each exceeded window, but never longer than maxBlockSeconds", () => {
    let t = 0;
    const rl = createRateLimitMemory({ buckets: { account: { limit: 2, windowSeconds: 60, key: "username", maxBlockSeconds: 300 } } }, () => t);
    const exhaust = () => {
      rl.hit("account", "victim");
      rl.hit("account", "victim");
      return rl.hit("account", "victim");
    };
    const blocks: number[] = [];
    for (let round = 0; round < 6; round++) {
      const refused = exhaust();
      expect(refused.allowed).toBe(false);
      blocks.push(refused.retryAfterSeconds);
      t += refused.retryAfterSeconds * 1000;
      expect(rl.hit("account", "victim").allowed).toBe(true);
    }
    expect(blocks).toEqual([60, 120, 240, 300, 300, 300]);
    t += 600_000;
    rl.hit("account", "victim");
    rl.hit("account", "victim");
    expect(rl.hit("account", "victim").retryAfterSeconds).toBe(60);
  });
});

describe("ratelimit/memory account keys", () => {
  async function bootWith(bucket: Record<string, unknown>) {
    return module.setup(module.configSchema.parse({ buckets: { account: { limit: 3, windowSeconds: 300, key: "username", ...bucket } } }), deps);
  }
  const check = definePipeline({ name: "login", steps: ["ratelimit.check:account"] });

  for (const field of ["username", "email"] as const) {
    it(`counts by the ${field} field alone, so a decoy in the other field does not open a new budget`, async () => {
      const instance = await bootWith({ field });
      const decoy = field === "username" ? "email" : "username";
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await runPipeline(check, { ip: `192.0.2.${i}`, body: { [field]: "Victim@Example.org", [decoy]: `decoy-${i}` } }, { modules: [{ module, instance }] })).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    });
  }

  it("refuses a name longer than 320 characters before counting it", async () => {
    const instance = await bootWith({});
    const run = await runPipeline(check, { ip: "192.0.2.9", body: { username: "a".repeat(321) } }, { modules: [{ module, instance }] });
    expect(run).toMatchObject({ status: 400, code: "VALIDATION" });
    expect(usernameKey("a".repeat(320)).length).toBeLessThanOrEqual(64);
  });

  it("with counts: failures, counts only the runs that fail after the check, and forgets the account after a success", async () => {
    let outcome: "fail" | "pass" = "fail";
    const verdict = defineModule({
      name: "verdict/test",
      provides: [],
      requires: [],
      configSchema: z.object({}),
      async setup() {
        return {};
      },
      steps: () => ({ decide: async (ctx: Context) => (outcome === "fail" ? ctx.fail("UNAUTHENTICATED", "invalid credentials") : ok({ ...ctx, result: { ok: true } })) }),
      describe: () => ({ decide: { summary: "Passes or fails as the test says", reads: [], writes: ["result?"], output: { type: "object" } } }),
    });
    const kestrel = await bootKestrel({
      config: {
        modules: [{ use: "./verdict.ts", config: {} }, { use: "@michaelthielemann/kestrel-ratelimit-memory", config: { buckets: { account: { limit: 3, windowSeconds: 300, key: "username", counts: "failures" } } } }],
        triggers: [],
        http: null,
      },
      modules: [verdict, module],
      pipelines: [definePipeline({ name: "login", steps: ["ratelimit.check:account", "verdict.decide"] })],
      logger: silentLogger,
    });
    const run = async () => (await kestrel.run("login", { trigger: { kind: "http", name: "POST /login" }, ip: "192.0.2.1", body: { username: "victim" } })).status;
    outcome = "pass";
    for (let i = 0; i < 5; i++) expect(await run()).toBe(200);
    outcome = "fail";
    expect(await run()).toBe(401);
    expect(await run()).toBe(401);
    outcome = "pass";
    expect(await run()).toBe(200);
    outcome = "fail";
    for (let i = 0; i < 3; i++) expect(await run()).toBe(401);
    expect(await run()).toBe(429);
    await kestrel.stop();
  });
});
