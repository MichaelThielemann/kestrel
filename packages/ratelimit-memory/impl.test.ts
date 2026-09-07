import { describe, it, expect } from "vitest";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { isErr } from "@michaelthielemann/kestrel/result";
import { createRateLimitMemory } from "./impl.ts";
import module from "./module.ts";

describe("ratelimit/memory", () => {
  it("allows up to limit per window and key, then blocks until the window ends", () => {
    let t = 0;
    const rl = createRateLimitMemory({ buckets: { login: { limit: 2, windowSeconds: 60 } } }, () => t);
    expect(rl.hit("login", "a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.hit("login", "a")).toMatchObject({ allowed: true, remaining: 0 });
    expect(rl.hit("login", "a")).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    expect(rl.hit("login", "b").allowed).toBe(true);
    t = 60_000;
    expect(rl.hit("login", "a").allowed).toBe(true);
  });

  it("unknown buckets throw and sweep drops expired windows", () => {
    let t = 0;
    const rl = createRateLimitMemory({ buckets: { login: { limit: 1, windowSeconds: 1 } } }, () => t);
    expect(() => rl.hit("nope", "a")).toThrow(/unknown bucket/);
    rl.hit("login", "a");
    expect(rl.sweep()).toBe(0);
    t = 1_000;
    expect(rl.sweep()).toBe(1);
  });

  it("two boots keep their own buckets; the first instance's check step still resolves against it", async () => {
    const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: { step() {}, info() {}, error() {} }, root: process.cwd() };
    const first = await module.setup(module.configSchema.parse({ buckets: { login: { limit: 1, windowSeconds: 60 } } }), deps);
    await module.setup(module.configSchema.parse({ buckets: { other: { limit: 5, windowSeconds: 60 } } }), deps);
    const check = module.steps!(first).check;
    expect(() => check("login")).not.toThrow();
    await expect(check("login")(createContext({ trigger: { kind: "http", name: "t" } }))).resolves.toBeDefined();
  });

  it("check step fails RATE_LIMITED with details.retryAfterSeconds once the bucket is exhausted", async () => {
    const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: { step() {}, info() {}, error() {} }, root: process.cwd() };
    const instance = await module.setup(module.configSchema.parse({ buckets: { login: { limit: 1, windowSeconds: 60 } } }), deps);
    const check = module.steps!(instance).check("login");
    const ctx = createContext({ trigger: { kind: "http", name: "t" }, ip: "1.2.3.4" });

    const first = await check(ctx);
    expect(isErr(first)).toBe(false);

    const second = await check(ctx);
    if (!isErr(second)) throw new Error("expected an Err");
    expect(second.error.code).toBe("RATE_LIMITED");
    expect(second.error.status).toBe(429);
    expect(second.error.retryable).toBe(true);
    expect(second.error.details).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("counts requests without a client ip in one shared bucket key instead of skipping them", async () => {
    const deps: Deps = { get: () => { throw new Error("not needed"); }, find: () => undefined, logger: { step() {}, info() {}, error() {} }, root: process.cwd() };
    const instance = await module.setup(module.configSchema.parse({ buckets: { login: { limit: 1, windowSeconds: 60 } } }), deps);
    const check = module.steps!(instance).check("login");
    expect(isErr(await check(createContext({ trigger: { kind: "http", name: "t" } })))).toBe(false);
    const second = await check(createContext({ trigger: { kind: "cron", name: "t" } }));
    if (!isErr(second)) throw new Error("expected an Err");
    expect(second.error.code).toBe("RATE_LIMITED");
    expect(isErr(await check(createContext({ trigger: { kind: "http", name: "t" }, ip: "1.2.3.4" })))).toBe(false);
  });
});
