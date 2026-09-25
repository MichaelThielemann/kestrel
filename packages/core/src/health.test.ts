import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, type Kestrel } from "./boot.ts";
import { defineContract } from "./defineContract.ts";
import { defineModule, type Introspection, type ModuleHealth } from "./defineModule.ts";
import { silentLogger, type Logger } from "./logger.ts";

interface Store {
  get(id: string): Promise<string | null>;
}
const STORE = defineContract<Store>()("store@1", ["get"]);

const store = defineModule({
  name: "store/memory",
  provides: [STORE],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup(): Promise<Store> {
    return { get: async () => null };
  },
});

const config = {
  modules: [{ use: "./modules/store.ts", config: {} }],
  triggers: [],
  http: null,
};
async function booted(extra: Array<{ mod: Parameters<typeof boot>[0]["modules"][number]; use: string }> = []): Promise<Kestrel> {
  return boot({
    config: { ...config, modules: [...config.modules, ...extra.map((e) => ({ use: e.use, config: {} }))] },
    modules: [store, ...extra.map((e) => e.mod)],
    pipelines: [],
    logger: silentLogger,
  });
}

describe("kestrel.health()", () => {
  it("lists no modules when none declare the hook", async () => {
    const kestrel = await booted();
    expect(kestrel.health()).toEqual({ ok: true, restartRequired: false, modules: [] });
    await kestrel.stop();
  });

  it("lists a module that declares health() as ok", async () => {
    const healthy = defineModule({
      name: "watcher/healthy",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      health: (): ModuleHealth => ({ ok: true }),
    });
    const kestrel = await booted([{ mod: healthy, use: "./watcher-healthy.ts" }]);
    expect(kestrel.health()).toEqual({ ok: true, restartRequired: false, modules: [{ module: "watcher/healthy", ok: true }] });
    await kestrel.stop();
  });

  it("is not ok and requires a restart when a module reports it", async () => {
    const broken = defineModule({
      name: "watcher/broken",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      health: (): ModuleHealth => ({ ok: false, reason: "the store is unusable after a failed rollback", restartRequired: true }),
    });
    const kestrel = await booted([{ mod: broken, use: "./watcher-broken.ts" }]);
    expect(kestrel.health()).toEqual({
      ok: false,
      restartRequired: true,
      modules: [{ module: "watcher/broken", ok: false, reason: "the store is unusable after a failed rollback", restartRequired: true }],
    });
    await kestrel.stop();
  });

  it("lists a module whose health() throws as not ok with a fixed reason, and logs the error once", async () => {
    const errors: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const logger: Logger = { ...silentLogger, error: (message, data) => errors.push({ message, ...(data === undefined ? {} : { data }) }) };
    const throwing = defineModule({
      name: "watcher/throwing",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      health: (): ModuleHealth => {
        throw new Error("secret detail");
      },
    });
    const kestrel = await boot({
      config: { ...config, modules: [...config.modules, { use: "./watcher-throwing.ts", config: {} }] },
      modules: [store, throwing],
      pipelines: [],
      logger,
    });
    const expected = { ok: false, restartRequired: false, modules: [{ module: "watcher/throwing", ok: false, reason: "health() threw", restartRequired: false }] };
    expect(kestrel.health()).toEqual(expected);
    expect(kestrel.health()).toEqual(expected);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("watcher/throwing");
    expect(String(errors[0]?.data?.error)).toContain("secret detail");
    await kestrel.stop();
  });

  it("is reachable from attach() through Introspection, mirroring describe()", async () => {
    let seen: ReturnType<Introspection["health"]> | undefined;
    const watcher = defineModule({
      name: "watcher/attach",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      attach(_instance, kestrel: Introspection) {
        seen = kestrel.health();
      },
    });
    const kestrel = await booted([{ mod: watcher, use: "./watcher-attach.ts" }]);
    expect(seen).toEqual({ ok: true, restartRequired: false, modules: [] });
    await kestrel.stop();
  });
});

describe("http.healthPath", () => {
  let state: ModuleHealth | "throws" = { ok: true };
  const watched = defineModule({
    name: "watcher/switchable",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return {};
    },
    health: (): ModuleHealth => {
      if (state === "throws") throw new Error("broken hook");
      return state;
    },
  });

  async function served(): Promise<{ kestrel: Kestrel; base: string }> {
    const kestrel = await boot({
      config: { ...config, modules: [...config.modules, { use: "./watcher-switchable.ts", config: {} }], http: { port: 0 } },
      modules: [store, watched],
      pipelines: [],
      logger: silentLogger,
    });
    const { http } = await kestrel.start();
    return { kestrel, base: `http://127.0.0.1:${http?.port ?? 0}` };
  }

  it("answers 200 with only ok and restartRequired while every module is ok", async () => {
    state = { ok: true };
    const { kestrel, base } = await served();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restartRequired: false });
    await kestrel.stop();
  });

  it("answers 200 with ok false and no module detail when a module is not ok but recovers on its own", async () => {
    state = { ok: false, reason: "catching up", restartRequired: false };
    const { kestrel, base } = await served();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, restartRequired: false });
    await kestrel.stop();
  });

  it("answers 503 once a module requires a restart, read on every request", async () => {
    state = { ok: true };
    const { kestrel, base } = await served();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    state = { ok: false, reason: "the store is unusable after a failed rollback", restartRequired: true };
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, restartRequired: true });
    await kestrel.stop();
  });

  it("answers 200 with ok false, not 500, while a module's health() throws", async () => {
    state = "throws";
    const { kestrel, base } = await served();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, restartRequired: false });
    await kestrel.stop();
  });
});
