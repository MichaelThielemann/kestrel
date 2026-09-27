import { describe, expect, it } from "vitest";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { clientKey, createRateLimitMemory } from "./impl.ts";
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
