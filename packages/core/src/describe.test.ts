import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, type Kestrel } from "./boot.ts";
import { stepFactory, type Context } from "./context.ts";
import { defineContract } from "./defineContract.ts";
import { defineModule, type Introspection } from "./defineModule.ts";
import { definePipeline } from "./definePipeline.ts";
import { coreVersion, packageVersion, PLACEHOLDER_ARG } from "./describe.ts";
import { KestrelBootError } from "./errors.ts";
import { silentLogger } from "./logger.ts";
import { ok } from "./result.ts";

interface Store {
  get(id: string): Promise<string | null>;
}
const STORE = defineContract<Store>()("store@1", ["get"]);

const store = defineModule({
  name: "store/memory",
  provides: [STORE],
  requires: [],
  configSchema: z.object({ file: z.string(), token: z.string().describe("secret").optional(), retries: z.number().int().default(3) }).strict(),
  async setup(): Promise<Store> {
    return { get: async () => null };
  },
  steps: () => ({
    find: stepFactory((collection: string) => async (ctx: Context) => ok({ ...ctx, result: { collection } })),
    ping: async (ctx: Context) => ok({ ...ctx, result: "pong" }),
  }),
  describe: () => ({
    find: (collection: string) => ({ summary: `Find in ${collection}`, reads: [], writes: ["result"], output: { type: "object" } }),
    ping: { summary: "Ping", reads: [], writes: ["result"] },
  }),
});

const bus = defineModule({
  name: "bus/memory",
  provides: [],
  requires: [STORE],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  triggers: { event: () => () => {} },
});

const config = {
  modules: [
    { use: "./modules/store.ts", config: { file: "/data/secret.db", token: "hunter2" } },
    { use: "@example/kestrel-bus-memory", config: {} },
  ],
  triggers: [
    { http: "GET /things/:id", pipeline: "read" },
    { event: "thing.created", pipeline: "read" },
    { cron: "*/5 * * * *", pipeline: "ping" },
  ],
  http: null,
};
const pipelines = [definePipeline({ name: "read", steps: ["store.find:things"] }), definePipeline({ name: "ping", steps: ["store.ping"] })];

async function booted(extra: Parameters<typeof boot>[0]["modules"] = []): Promise<Kestrel> {
  return boot({ config: { ...config, modules: [...config.modules, ...extra.map((m) => ({ use: `./${m.name}.ts`, config: {} }))] }, modules: [store, bus, ...extra], pipelines, logger: silentLogger });
}

describe("kestrel.describe()", () => {
  it("lists modules with contracts, config schema, variables, steps and the event hook", async () => {
    const kestrel = await booted();
    const manifest = kestrel.describe();
    expect(manifest.core.version).toBe(coreVersion());
    expect(manifest.contracts).toEqual(["store@1"]);
    const [storeManifest, busManifest] = manifest.modules;
    expect(storeManifest).toMatchObject({ name: "store/memory", use: "./modules/store.ts", version: null, provides: ["store@1"], requires: [], optional: [], steps: ["store.find", "store.ping"], eventHook: false, emits: [] });
    expect(storeManifest!.config.schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(storeManifest!.config.variables).toEqual([
      { path: "file", type: "string", required: true, secret: false, set: true, status: "set" },
      { path: "token", type: "string", required: false, secret: true, set: true, status: "set" },
      { path: "retries", type: "integer", required: false, default: 3, secret: false, set: false, status: "default" },
    ]);
    expect(busManifest).toMatchObject({ name: "bus/memory", requires: ["store@1"], eventHook: true, version: null, steps: [] });
    await kestrel.stop();
  });

  it("never contains a config value", async () => {
    const kestrel = await booted();
    const text = JSON.stringify(kestrel.describe());
    expect(text).not.toContain("secret.db");
    expect(text).not.toContain("hunter2");
    await kestrel.stop();
  });

  it("describes steps with owner and factory flag, factories through the placeholder argument", async () => {
    const kestrel = await booted();
    const steps = kestrel.describe().steps;
    expect(steps).toEqual([
      { name: "store.find", module: "store/memory", factory: true, description: { summary: `Find in ${PLACEHOLDER_ARG}`, reads: [], writes: ["result"], output: { type: "object" } } },
      { name: "store.ping", module: "store/memory", factory: false, description: { summary: "Ping", reads: [], writes: ["result"] } },
    ]);
    await kestrel.stop();
  });

  it("stops the boot when a factory describe() throws for the placeholder argument", async () => {
    const broken = defineModule({
      name: "broken/describe",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ boom: stepFactory(() => async (ctx: Context) => ok(ctx)) }),
      describe: () => ({
        boom: (arg: string) => {
          if (arg === PLACEHOLDER_ARG) throw new Error("needs a real argument");
          return { summary: arg, reads: [], writes: [] };
        },
      }),
    });
    await expect(booted([broken])).rejects.toThrow(/\[broken\/describe\] step "broken\.boom" describe\(\) threw for the placeholder argument "<arg>": needs a real argument/);
  });

  it("lists pipelines with their resolved steps and every trigger", async () => {
    const kestrel = await booted();
    const manifest = kestrel.describe();
    expect(manifest.pipelines).toEqual([
      { name: "read", steps: [{ spec: "store.find:things", name: "store.find", module: "store/memory", description: { summary: "Find in things", reads: [], writes: ["result"], output: { type: "object" } } }] },
      { name: "ping", steps: [{ spec: "store.ping", name: "store.ping", module: "store/memory", description: { summary: "Ping", reads: [], writes: ["result"] } }] },
    ]);
    expect(manifest.triggers).toEqual({
      http: [{ method: "GET", path: "/things/:id", pipeline: "read" }],
      events: [{ event: "thing.created", pipeline: "read" }],
      crons: [{ expression: "*/5 * * * *", pipeline: "ping" }],
    });
    await kestrel.stop();
  });

  it("is computed once", async () => {
    const kestrel = await booted();
    expect(kestrel.describe()).toBe(kestrel.describe());
    await kestrel.stop();
  });
});

describe("packageVersion", () => {
  it("reads the version of the package a use entry names and answers null for paths and unknown packages", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-describe-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer" }));
    const pkg = join(root, "node_modules", "@scope", "kestrel-thing");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/kestrel-thing", version: "1.2.3", exports: { ".": "./module.js", "./impl": "./impl.js" } }));
    writeFileSync(join(pkg, "module.js"), "export default {};");
    writeFileSync(join(pkg, "impl.js"), "export default {};");
    expect(packageVersion(root, "@scope/kestrel-thing")).toBe("1.2.3");
    expect(packageVersion(root, "@scope/kestrel-thing/impl")).toBe("1.2.3");
    expect(packageVersion(root, "./modules/local.ts")).toBeNull();
    expect(packageVersion(root, "@scope/kestrel-missing")).toBeNull();
  });
});

describe("attach hook", () => {
  it("receives the manifest and the observer registration at the end of boot and is detached on stop", async () => {
    const seen: string[] = [];
    let detached = false;
    let stepsSeen = 0;
    const watcher = defineModule({
      name: "watcher/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      attach(_instance, kestrel: Introspection) {
        seen.push(...kestrel.describe().pipelines.map((p) => p.name));
        const off = kestrel.observe({ stepEnd: () => stepsSeen++ });
        return () => {
          off();
          detached = true;
        };
      },
    });
    const kestrel = await booted([watcher]);
    expect(seen).toEqual(["read", "ping"]);
    await kestrel.run("ping", { trigger: { kind: "http", name: "GET /ping" } });
    expect(stepsSeen).toBe(1);
    await kestrel.stop();
    expect(detached).toBe(true);
    await kestrel.run("ping", { trigger: { kind: "http", name: "GET /ping" } });
    expect(stepsSeen).toBe(1);
  });

  it("turns a throwing attach into a boot error and tears the modules down", async () => {
    let torndown = false;
    const broken = defineModule({
      name: "broken/test",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      attach() {
        throw new Error("nope");
      },
      teardown() {
        torndown = true;
      },
    });
    await expect(booted([broken])).rejects.toMatchObject(new KestrelBootError("broken/test", "attach() threw: nope"));
    expect(torndown).toBe(true);
  });
});

describe("kestrel.observe()", () => {
  it("delivers run and step events to every observer and survives a throwing one", async () => {
    const kestrel = await booted();
    const events: string[] = [];
    kestrel.observe({
      runStart: (e) => events.push(`runStart ${e.pipeline} ${e.trigger.kind}`),
      runEnd: (e) => events.push(`runEnd ${e.pipeline} ${e.status} ${e.outcome}`),
      stepStart: (e) => events.push(`stepStart ${e.step}`),
      stepEnd: (e) => events.push(`stepEnd ${e.step} ${e.status} ${e.outcome}`),
    });
    kestrel.observe({
      runStart: () => {
        throw new Error("observer bug");
      },
    });
    const res = await kestrel.run("read", { trigger: { kind: "http", name: "GET /things/1" }, params: { id: "1" } });
    expect(res.status).toBe(200);
    expect(events).toEqual(["runStart read http", "stepStart store.find:things", "stepEnd store.find:things 200 ok", "runEnd read 200 ok"]);
    await kestrel.stop();
  });
});
