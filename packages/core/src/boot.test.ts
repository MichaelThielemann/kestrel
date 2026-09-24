import { Server } from "node:http";
import { describe, it, expect, expectTypeOf, afterEach, beforeEach, vi } from "vitest";
import { z } from "zod";
import { boot, type Kestrel, type UnemittedEventWarning, type UnwrittenOptionalReadWarning } from "./boot.ts";
import { boundaryCast } from "./cast.ts";
import { binaryResult, stepFactory, type Context } from "./context.ts";
import { defineContract } from "./defineContract.ts";
import { defineModule } from "./defineModule.ts";
import { definePipeline } from "./definePipeline.ts";
import { KestrelBootError } from "./errors.ts";
import { ok } from "./result.ts";
import { silentLogger } from "./logger.ts";

interface Identity {
  id: string;
  claims: Record<string, unknown>;
}
declare global {
  namespace Kestrel {
    interface ContextExtensions {
      identity?: Identity;
    }
  }
}

interface Store {
  put(collection: string, id: string, doc: Record<string, unknown>): Promise<void>;
  get(collection: string, id: string): Promise<Record<string, unknown> | null>;
  all(collection: string): Promise<Record<string, unknown>[]>;
}
interface Auth {
  resolve(token: string): Promise<Identity | null>;
}
interface Guard {
  can(identity: Identity, permission: string): Promise<boolean>;
}
type Handler = (name: string, data: Record<string, unknown>) => Promise<void>;
interface Bus {
  emit(name: string, data: Record<string, unknown>): Promise<void>;
  on(name: string, handler: Handler): () => void;
}

const STORE = defineContract<Store>()("store@1", ["put", "get", "all"]);
const AUTH = defineContract<Auth>()("auth@1", ["resolve"]);
const GUARD = defineContract<Guard>()("guard@1", ["can"]);
const EVENTS = defineContract<Bus>()("events@1", ["emit", "on"]);

const store = defineModule({
  name: "store/memory",
  provides: [STORE],
  requires: [],
  configSchema: z.object({ file: z.string() }).strict(),
  async setup(): Promise<Store> {
    const data = new Map<string, Map<string, Record<string, unknown>>>();
    const table = (c: string) => data.get(c) ?? data.set(c, new Map()).get(c)!;
    return {
      async put(c, id, doc) { table(c).set(id, doc); },
      async get(c, id) { return table(c).get(id) ?? null; },
      async all(c) { return [...table(c).values()]; },
    };
  },
  steps: (db) => ({
    create: stepFactory((collection: string) => async (ctx: Context) => {
      const id = String(ctx.payload.id);
      await db.put(collection, id, { ...ctx.payload, id });
      return ok({ ...ctx, result: { ...ctx.payload, id } });
    }),
    findOne: stepFactory((collection: string) => async (ctx: Context) => {
      const doc = await db.get(collection, ctx.params.id ?? "");
      if (!doc) return ctx.fail("NOT_FOUND", `${collection}/${ctx.params.id ?? ""} not found`);
      return ok({ ...ctx, result: doc });
    }),
    upload: async (ctx: Context) => {
      const file = ctx.files[0];
      if (!file) return ctx.fail("VALIDATION", "no file");
      await db.put("files", file.filename, { field: file.field, contentType: file.contentType, data: [...file.data], note: ctx.payload.note });
      return ok({ ...ctx, result: { filename: file.filename, size: file.data.byteLength } });
    },
    download: async (ctx: Context) => {
      const doc = await db.get("files", ctx.params.name ?? "");
      if (!doc) return ctx.fail("NOT_FOUND", "no such file");
      return ok({ ...ctx, result: binaryResult(new Uint8Array(boundaryCast<number[]>(doc.data, "host")), boundaryCast<string>(doc.contentType, "host"), ctx.params.name) });
    },
    log: stepFactory((collection: string) => async (ctx: Context) => {
      await db.put(collection, String(ctx.payload.at), ctx.payload);
      return ok(ctx);
    }),
  }),
  describe: () => ({
    create: (collection: string) => ({ summary: `create a ${collection} document`, reads: [], writes: ["result"], output: { type: "object" } }),
    findOne: (collection: string) => ({ summary: `read a ${collection} document`, reads: ["params.id"], writes: ["result"], output: { type: "object" } }),
    upload: { summary: "store an uploaded file", reads: ["files"], writes: ["result"], output: { type: "object", properties: { filename: { type: "string" }, size: { type: "number" } }, required: ["filename", "size"] } },
    download: { summary: "serve a stored file", reads: ["params.name"], writes: ["result"], binary: true },
    log: (collection: string) => ({ summary: `append to ${collection}`, reads: [], writes: [] }),
  }),
});

function tokenOf(ctx: Context): string | undefined {
  return ctx.headers.authorization?.replace(/^Bearer /, "") ?? /kestrel_token=([^;]+)/.exec(ctx.headers.cookie ?? "")?.[1];
}

const auth = defineModule({
  name: "auth/fake",
  provides: [AUTH],
  requires: [STORE],
  configSchema: z.object({}).strict(),
  async setup(_config, deps): Promise<Auth> {
    if (typeof deps.get(STORE).get !== "function") throw new Error("store dep missing");
    return { async resolve(token) { return token === "t-admin" ? { id: "admin", claims: { role: "admin" } } : null; } };
  },
  steps: (a) => ({
    identifyUser: async (ctx: Context) => {
      const identity = await a.resolve(tokenOf(ctx) ?? "");
      return ok(identity ? { ...ctx, identity } : ctx);
    },
    requireUser: async (ctx: Context) => {
      const identity = await a.resolve(tokenOf(ctx) ?? "");
      if (!identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      return ok({ ...ctx, identity });
    },
    loadIdentity: async (ctx: Context) => ok({ ...ctx, result: ctx.identity ?? null }),
  }),
  describe: () => ({
    identifyUser: { summary: "resolve the caller if a token is present", reads: [], writes: ["identity?"] },
    requireUser: { summary: "resolve the caller or fail", reads: [], writes: ["identity"] },
    loadIdentity: { summary: "return the resolved identity", reads: ["identity"], writes: ["result"], output: { type: ["object", "null"] } },
  }),
});

const guard = defineModule({
  name: "guard/fake",
  provides: [GUARD],
  requires: [AUTH],
  configSchema: z.object({}).strict(),
  async setup(): Promise<Guard> {
    return { async can(identity, permission) { return identity.claims.role === "admin" && permission.startsWith("pages."); } };
  },
  steps: (g) => ({
    require: stepFactory((permission: string) => async (ctx: Context) => {
      if (!ctx.identity) return ctx.fail("UNAUTHENTICATED", "not authenticated");
      if (!(await g.can(ctx.identity, permission))) return ctx.fail("FORBIDDEN", permission);
      return ok(ctx);
    }),
  }),
  describe: () => ({ require: (permission: string) => ({ summary: `require "${permission}"`, reads: [], writes: [] }) }),
});

const events = defineModule({
  name: "events/fake",
  provides: [EVENTS],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup(): Promise<Bus> {
    const handlers = new Map<string, Set<Handler>>();
    return {
      async emit(name, data) { for (const h of handlers.get(name) ?? []) await h(name, data); },
      on(name, h) {
        const set = handlers.get(name) ?? handlers.set(name, new Set()).get(name)!;
        set.add(h);
        return () => set.delete(h);
      },
    };
  },
  triggers: {
    event: (bus, entries, run, logger) => {
      const offs = entries.map((entry) =>
        bus.on(entry.event, async (name, data) => {
          const res = await run(entry.pipeline, { trigger: { kind: "event", name }, payload: data });
          if (res.status >= 400) logger.error(`event "${name}" ended with ${res.status}`, { runId: res.runId });
        }),
      );
      return () => {
        for (const off of offs) off();
      };
    },
  },
  steps: (bus) => ({
    emit: stepFactory((name: string) => async (ctx: Context) => {
      await bus.emit(name, { event: name, at: Date.now(), identity: ctx.identity ?? null, result: ctx.result ?? null });
      return ok(ctx);
    }),
  }),
  describe: () => ({ emit: (name: string) => ({ summary: `emit "${name}"`, reads: [], writes: [] }) }),
});

const circular = defineModule({
  name: "circular/fake",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    loop: async (ctx: Context) => {
      const self: Record<string, unknown> = {};
      self.self = self;
      return ok({ ...ctx, result: self });
    },
  }),
  describe: () => ({ loop: { summary: "produce a circular result", reads: [], writes: ["result"], output: { type: "object" } } }),
});

const sanitize = defineModule({
  name: "sanitize/svg",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup(): Promise<null> {
    return null;
  },
  steps: () => ({ svg: async (ctx: Context) => ok(ctx) }),
  describe: () => ({ svg: { summary: "sanitize uploaded svg files", reads: ["files"], writes: ["files"] } }),
});

const typed = defineModule({
  name: "typed/step",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup(): Promise<null> {
    return null;
  },
  steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: ctx.payload.title }) }),
  describe: () => ({
    create: {
      summary: "create from a typed payload",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      query: { limit: { type: "integer" } },
      output: { type: "string" },
    },
  }),
});

const whoami = definePipeline({ name: "whoami", steps: ["auth.requireUser"] });
const createPage = definePipeline({ name: "createPage", steps: ["auth.requireUser", "guard.require:pages.write", "store.create:pages", "events.emit:page.created"] });
const readPage = definePipeline({ name: "readPage", steps: ["store.findOne:pages"] });
const onCreated = definePipeline({ name: "onCreated", steps: ["store.log:log"] });
const upload = definePipeline({ name: "upload", steps: ["store.upload"] });
const download = definePipeline({ name: "download", steps: ["store.download"] });

const baseConfig = {
  modules: [
    { use: "./guard", config: {} },
    { use: "./auth", config: {} },
    { use: "./store", config: { file: ":memory:" } },
    { use: "./events", config: {} },
  ],
  triggers: [
    { http: "POST /pages", pipeline: "createPage" },
    { http: "GET /pages/:id", pipeline: "readPage" },
    { http: "GET /whoami", pipeline: "whoami" },
    { http: "POST /files", pipeline: "upload" },
    { http: "GET /files/:name", pipeline: "download" },
  ],
  http: { port: 0, maxBodyBytes: 2048 },
};
const modules = [guard, auth, store, events];
const pipelines = [createPage, readPage, whoami, onCreated, upload, download];

const typedPipeline = definePipeline({ name: "typed", steps: ["typed.create"] });
const typedConfig = { modules: [{ use: "./typed", config: {} }], triggers: [], http: null };
const bootTyped = () => boot({ config: typedConfig, modules: [typed], pipelines: [typedPipeline], logger: silentLogger });
const runTyped = (instance: Kestrel, body: Record<string, unknown>, query: Record<string, unknown> = {}) => instance.run("typed", { trigger: { kind: "http", name: "POST /typed" }, payload: { ...query, ...body }, body, query });

let kestrel: Kestrel | undefined;
afterEach(async () => {
  await kestrel?.stop();
  kestrel = undefined;
  vi.unstubAllEnvs();
});

describe("boot", () => {
  it("wires modules in dependency order, registers contracts, steps and pipelines", async () => {
    kestrel = await boot({ config: baseConfig, modules, pipelines, logger: silentLogger });
    expect(kestrel.contracts.names().sort()).toEqual(["auth@1", "events@1", "guard@1", "store@1"]);
    expect(kestrel.steps.names().sort()).toEqual([
      "auth.identifyUser",
      "auth.loadIdentity",
      "auth.requireUser",
      "events.emit",
      "guard.require",
      "store.create",
      "store.download",
      "store.findOne",
      "store.log",
      "store.upload",
    ]);
    expect([...kestrel.pipelines.keys()].sort()).toEqual(["createPage", "download", "onCreated", "readPage", "upload", "whoami"]);
  });

  it("passes the same bootStartedAt to every module's setup(), captured before any setup() runs", async () => {
    const before = Date.now();
    const seen: number[] = [];
    const probe = defineModule({
      name: "probe/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps): Promise<null> {
        seen.push(deps.bootStartedAt ?? -1);
        return null;
      },
    });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./probe", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, probe], pipelines, logger: silentLogger });
    const after = Date.now();
    expect(seen).toHaveLength(1);
    const bootStartedAt = seen[0] ?? -1;
    expect(bootStartedAt).toBeGreaterThanOrEqual(before);
    expect(bootStartedAt).toBeLessThanOrEqual(after);
  });

  it("pairs config entries with modules by name, not by index", async () => {
    const swapped = { ...baseConfig, modules: [{ use: "./auth", config: {} }, { use: "./guard", config: {} }, { use: "./store", config: { file: ":memory:" } }, { use: "./events", config: {} }] };
    await expect(boot({ config: swapped, modules, pipelines, logger: silentLogger })).rejects.toThrow(/"\.\/auth" names module "auth\/fake", not "guard\/fake"/);
  });

  it("accepts an entry whose name matches no loaded module", async () => {
    const renamed = { ...baseConfig, modules: baseConfig.modules.map((m) => ({ ...m, use: `@acme/private-${m.use.slice(2)}-adapter` })) };
    kestrel = await boot({ config: renamed, modules, pipelines, logger: silentLogger });
    expect(kestrel.contracts.names()).toContain("store@1");
  });

  it("a module providing a contract must be named after it", async () => {
    const misnamed = defineModule({ name: "sqlite/persistence", provides: [STORE], requires: [], configSchema: z.object({}).strict(), async setup(): Promise<Store> { return { async put() {}, async get() { return null; }, async all() { return []; } }; } });
    const config = { modules: [{ use: "./sqlite/persistence", config: {} }], triggers: [] };
    await expect(boot({ config, modules: [misnamed], pipelines: [], logger: silentLogger })).rejects.toThrow(/\[sqlite\/persistence\] provides "store@1" but registers steps under "sqlite\."/);
  });

  it("two triggers on the same route pattern are a boot error", async () => {
    const triggers = [{ http: "GET /pages/:id", pipeline: "readPage" }, { http: "GET /pages/:slug", pipeline: "whoami" }];
    await expect(boot({ config: { ...baseConfig, triggers }, modules, pipelines, logger: silentLogger })).rejects.toThrow(/pipelines "readPage" and "whoami" both resolve to "GET \/pages\/:"/);
  });

  it("pipelines defined twice are a boot error", async () => {
    await expect(boot({ config: { ...baseConfig, triggers: [] }, modules, pipelines: [readPage, readPage], logger: silentLogger })).rejects.toThrow(/\[pipelines\/readPage\] defined twice/);
  });

  it("runs a pipeline through all steps", async () => {
    kestrel = await boot({ config: baseConfig, modules, pipelines, logger: silentLogger });
    const denied = await kestrel.run("createPage", { trigger: { kind: "http", name: "t" }, payload: { title: "x" } });
    expect(denied.status).toBe(401);
    const created = await kestrel.run("createPage", { trigger: { kind: "http", name: "t" }, payload: { id: "p1", title: "x" }, headers: { authorization: "Bearer t-admin" } });
    expect(created).toMatchObject({ status: 200, result: { id: "p1", title: "x" } });
    const read = await kestrel.run("readPage", { trigger: { kind: "http", name: "t" }, params: { id: "p1" } });
    expect(read.result).toEqual({ id: "p1", title: "x" });
  });

  it("serves HTTP triggers with params, body, token and error mapping", async () => {
    kestrel = await boot({ config: baseConfig, modules, pipelines, logger: silentLogger });
    const { http } = await kestrel.start();
    const base = `http://127.0.0.1:${http?.port ?? 0}`;

    const unauth = await fetch(`${base}/pages`, { method: "POST", body: JSON.stringify({ title: "x" }) });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ error: "not authenticated" });

    const created = await fetch(`${base}/pages`, { method: "POST", headers: { authorization: "Bearer t-admin" }, body: JSON.stringify({ id: "p1", title: "x" }) });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: "p1", title: "x" });

    const read = await fetch(`${base}/pages/p1`);
    expect(await read.json()).toEqual({ id: "p1", title: "x" });
    expect((await fetch(`${base}/pages/nope`)).status).toBe(404);
    expect((await fetch(`${base}/unknown`)).status).toBe(404);

    const badJson = await fetch(`${base}/pages`, { method: "POST", headers: { cookie: "kestrel_token=t-admin" }, body: "{oops" });
    expect(badJson.status).toBe(400);

    const viaCookie = await fetch(`${base}/whoami`, { headers: { cookie: "kestrel_token=t-admin" } });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.headers.get("x-kestrel-run-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(viaCookie.headers.get("x-content-type-options")).toBe("nosniff");
    expect(viaCookie.headers.get("cache-control")).toBe("no-store");
    expect(await (await fetch(`${base}/pages/nope`)).json()).toMatchObject({ error: expect.stringContaining("not found") as unknown, runId: expect.any(String) as unknown });

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it("serves /health even with no http triggers", async () => {
    kestrel = await boot({ config: { ...baseConfig, triggers: [] }, modules, pipelines, logger: silentLogger });
    const { http } = await kestrel.start();
    expect(http).toBeDefined();
    const health = await fetch(`http://127.0.0.1:${http?.port ?? 0}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it("passes the client ip, honouring x-forwarded-for only with trustProxy", async () => {
    const seen: Array<string | undefined> = [];
    const spy = defineModule({
      name: "spy/ip",
      provides: [],
      requires: [],
      configSchema: z.object({}),
      async setup() { return {}; },
      steps: () => ({ record: async (ctx: Context) => { seen.push(ctx.ip); return ok({ ...ctx, result: ctx.ip ?? null }); } }),
      describe: () => ({ record: { summary: "record the client ip", reads: ["ip"], writes: ["result"], output: { type: ["string", "null"] } } }),
    });
    const ipPipeline = definePipeline({ name: "ip", steps: ["spy.record"] });
    const config = (http: Record<string, unknown>) => ({ modules: [{ use: "./spy", config: {} }], triggers: [{ http: "GET /ip", pipeline: "ip" }], http: { port: 0, ...http } });
    const ipVia = async (http: Record<string, unknown>, headers: Record<string, string>) => {
      await kestrel?.stop();
      kestrel = await boot({ config: config(http), modules: [spy], pipelines: [ipPipeline], logger: silentLogger });
      const base = `http://127.0.0.1:${(await kestrel.start()).http?.port ?? 0}`;
      return (await fetch(`${base}/ip`, { headers })).json();
    };
    expect(await ipVia({ trustProxy: false }, { "x-forwarded-for": "203.0.113.9" })).toBe("127.0.0.1");
    expect(await ipVia({ trustProxy: true }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("10.0.0.1");
    expect(await ipVia({ trustProxy: true, proxyHops: 2 }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
    expect(await ipVia({ trustProxy: true, proxyHops: 3 }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBeNull();
    expect(await ipVia({ trustProxy: true }, {})).toBeNull();
    expect(await ipVia({ trustedHeader: "Trusted-Client-IP" }, { "trusted-client-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" })).toBe("198.51.100.7");
    expect(await ipVia({ trustedHeader: "Trusted-Client-IP", trustProxy: true }, { "x-forwarded-for": "203.0.113.9" })).toBeNull();
    await expect(boot({ config: config({ proxyHops: 0 }), modules: [spy], pipelines: [ipPipeline], logger: silentLogger })).rejects.toThrow(/proxyHops/);
  });

  it("rejects an http.allow entry that is neither an address nor a CIDR range at boot", async () => {
    await expect(boot({ config: { ...baseConfig, http: { port: 0, allow: ["10.0.0.0/8", "example.org"] } }, modules, pipelines, logger: silentLogger })).rejects.toThrow(/http\.allow: ip allowlist: invalid entry "example.org"/);
    kestrel = await boot({ config: { ...baseConfig, http: { port: 0, allow: ["10.0.0.0/8"] } }, modules, pipelines, logger: silentLogger });
    const { http } = await kestrel.start();
    expect((await fetch(`http://127.0.0.1:${http?.port ?? 0}/health`)).status).toBe(403);
  });

  it("accepts multipart uploads and serves binary results", async () => {
    kestrel = await boot({ config: baseConfig, modules, pipelines, logger: silentLogger });
    const { http } = await kestrel.start();
    const base = `http://127.0.0.1:${http?.port ?? 0}`;
    const form = new FormData();
    form.set("note", "hello");
    form.set("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }), "pic.png");
    const uploaded = await fetch(`${base}/files`, { method: "POST", body: form });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({ filename: "pic.png", size: 4 });

    const downloaded = await fetch(`${base}/files/pic.png`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(downloaded.headers.get("content-disposition")).toBe('inline; filename="pic.png"');
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloaded.headers.get("content-security-policy")).toContain("sandbox");
    expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual([1, 2, 3, 4]);

    const tooBig = await fetch(`${base}/files`, { method: "POST", body: new Uint8Array(4096), headers: { "content-type": "application/octet-stream" } });
    expect(tooBig.status).toBe(413);
  });

  it("serves configured inlineTypes inline", async () => {
    kestrel = await boot({
      config: { ...baseConfig, modules: [...baseConfig.modules, { use: "./sanitize", config: {} }], http: { ...baseConfig.http, inlineTypes: ["image/svg+xml"] } },
      modules: [...modules, sanitize],
      pipelines,
      logger: silentLogger,
    });
    const { http } = await kestrel.start();
    const base = `http://127.0.0.1:${http?.port ?? 0}`;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/svg+xml" }), "pic.svg");
    const uploaded = await fetch(`${base}/files`, { method: "POST", body: form });
    expect(uploaded.status).toBe(200);

    const downloaded = await fetch(`${base}/files/pic.svg`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toBe('inline; filename="pic.svg"');
  });

  it("refuses inline svg delivery without a sanitize.svg step", async () => {
    await expect(boot({ config: { ...baseConfig, http: { ...baseConfig.http, inlineTypes: ["image/svg+xml"] } }, modules, pipelines, logger: silentLogger })).rejects.toThrow(
      /http.inlineTypes contains "image\/svg\+xml" but no module registers the step "sanitize.svg"/,
    );
  });

  it("carries a run id on every router-level response", async () => {
    const loop = definePipeline({ name: "loop", steps: ["circular.loop"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./circular", config: {} }], triggers: [...baseConfig.triggers, { http: "GET /loop", pipeline: "loop" }], http: { ...baseConfig.http, corsOrigin: "http://localhost:3000" } };
    kestrel = await boot({ config, modules: [...modules, circular], pipelines: [...pipelines, loop], logger: silentLogger });
    const base = `http://127.0.0.1:${(await kestrel.start()).http?.port ?? 0}`;
    const uuid = /^[0-9a-f-]{36}$/;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-kestrel-run-id")).toMatch(uuid);

    for (const [label, res] of [
      ["404", await fetch(`${base}/nope`)],
      ["413", await fetch(`${base}/files`, { method: "POST", body: new Uint8Array(4096), headers: { "content-type": "application/octet-stream" } })],
      ["400", await fetch(`${base}/pages`, { method: "POST", body: "{oops", headers: { "content-type": "application/json" } })],
      ["500", await fetch(`${base}/loop`)],
    ] as const) {
      expect(label, `status for ${label}`).toBe(String(res.status));
      const runId = res.headers.get("x-kestrel-run-id");
      expect(runId, `header for ${label}`).toMatch(uuid);
      expect(await res.json(), `body for ${label}`).toMatchObject({ runId });
    }

    const preflight = await fetch(`${base}/pages`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preflight.headers.get("cache-control")).toBe("no-store");
    expect(preflight.headers.get("access-control-max-age")).toBe("600");
  });

  it("event triggers run pipelines through the module's triggers.event hook", async () => {
    kestrel = await boot({ config: { ...baseConfig, triggers: [{ event: "page.created", pipeline: "onCreated" }] }, modules, pipelines, logger: silentLogger });
    await kestrel.start();
    const db = kestrel.contracts.get(STORE);
    await kestrel.run("createPage", { trigger: { kind: "http", name: "t" }, payload: { id: "p1", title: "x" }, headers: { authorization: "Bearer t-admin" } });
    const rows = await db.all("log");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "page.created", identity: { id: "admin" }, result: { id: "p1", title: "x" } });
    await kestrel.stop();
    await kestrel.contracts.get(EVENTS).emit("page.created", { at: 1 });
    expect(await db.all("log")).toHaveLength(1);
  });

  it("gives a consumer-style module the configured event triggers during setup()", async () => {
    let recorded: unknown;
    const probe = defineModule({
      name: "probe/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps): Promise<null> {
        recorded = deps.eventTriggers;
        return null;
      },
    });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./probe", config: {} }], triggers: [{ event: "page.created", pipeline: "onCreated" }] };
    kestrel = await boot({ config, modules: [...modules, probe], pipelines, logger: silentLogger });
    expect(recorded).toEqual([{ event: "page.created", pipeline: "onCreated" }]);
    expect(recorded).toEqual(kestrel.triggers.events);
  });

  it("deps.eventTriggers is the configured list, not the effective one — it still names a pipeline that turns out not to exist", async () => {
    let recorded: unknown;
    const probe = defineModule({
      name: "probe/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps): Promise<null> {
        recorded = deps.eventTriggers;
        return null;
      },
    });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./probe", config: {} }], triggers: [{ event: "page.created", pipeline: "noSuchPipeline" }] };
    await expect(boot({ config, modules: [...modules, probe], pipelines, logger: silentLogger })).rejects.toThrow(/trigger references unknown pipeline "noSuchPipeline"/);
    expect(recorded).toEqual([{ event: "page.created", pipeline: "noSuchPipeline" }]);
  });

  it("warns once for an event trigger no pipeline emits and no module declares", async () => {
    const warnings: { message: string; data: Record<string, unknown> | undefined }[] = [];
    const logger = { ...silentLogger, warn: (message: string, data?: Record<string, unknown>) => warnings.push({ message, data }) };
    kestrel = await boot({ config: { ...baseConfig, triggers: [{ event: "page.creted", pipeline: "onCreated" }] }, modules, pipelines, logger });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/no pipeline emits via events\.emit and no module declares in emits/);
    expect(warnings[0]?.data).toEqual({ event: "page.creted", pipeline: "onCreated" });
    expect(kestrel.warnings).toEqual([{ code: "unemitted-event", message: warnings[0]?.message, pipeline: "onCreated", event: "page.creted" }]);
  });

  it("describe() carries the same boot warnings as kestrel.warnings", async () => {
    kestrel = await boot({ config: { ...baseConfig, triggers: [{ event: "page.creted", pipeline: "onCreated" }] }, modules, pipelines, logger: silentLogger });
    expect(kestrel.describe().warnings).toEqual(kestrel.warnings);
    expect(kestrel.describe().warnings).not.toEqual([]);
  });

  it("describe() carries no warnings for a clean boot", async () => {
    kestrel = await boot({ config: baseConfig, modules, pipelines, logger: silentLogger });
    expect(kestrel.describe().warnings).toEqual([]);
  });

  it("every boot warning field besides code is a string", () => {
    expectTypeOf<Omit<UnemittedEventWarning, "code">>().toMatchTypeOf<Record<string, string>>();
    expectTypeOf<Omit<UnwrittenOptionalReadWarning, "code">>().toMatchTypeOf<Record<string, string>>();
  });

  it("fails to boot for a step that writes result without declaring output, extendsOutput, extendsItems or binary: true", async () => {
    const bare = defineModule({
      name: "bare/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: { id: "x" } }) }),
      describe: () => ({ create: { summary: "create with no declared output", reads: [], writes: ["result"] } }),
    });
    const bareCreate = definePipeline({ name: "bareCreate", steps: ["bare.create"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./bare", config: {} }] };
    await expect(boot({ config, modules: [...modules, bare], pipelines: [...pipelines, bareCreate], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/bareCreate\] step "bare\.create" writes result without declaring output, extendsOutput, extendsItems or binary: true/,
    );
  });

  it("fails to boot for an object schema that declares properties without required in a step's output", async () => {
    const loose = defineModule({
      name: "loose/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: { id: "x", meta: { hits: 1 } } }) }),
      describe: () => ({
        create: {
          summary: "create with an output object schema that has no required",
          reads: [],
          writes: ["result"],
          output: { type: "object", properties: { id: { type: "string" }, meta: { type: "object", properties: { hits: { type: "integer" } }, required: ["hits"] } } },
        },
      }),
    });
    const looseCreate = definePipeline({ name: "looseCreate", steps: ["loose.create"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./loose", config: {} }] };
    await expect(boot({ config, modules: [...modules, loose], pipelines: [...pipelines, looseCreate], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/looseCreate\] step "loose\.create"'s output schema at \$\.output declares properties without declaring required/,
    );
  });

  it("fails to boot when a step's extendsOutput cannot fold onto the active output schema", async () => {
    const listy = defineModule({
      name: "listy/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        list: async (ctx: Context) => ok({ ...ctx, result: ["a", "b"] }),
        tag: async (ctx: Context) => ok(ctx),
      }),
      describe: () => ({
        list: { summary: "a list result", reads: [], writes: ["result"], output: { type: "array", items: { type: "string" } } },
        tag: { summary: "extends the (list) result with an object field", reads: [], writes: ["result.tag?"], extendsOutput: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } },
      }),
    });
    const listThenTag = definePipeline({ name: "listThenTag", steps: ["listy.list", "listy.tag"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./listy", config: {} }] };
    await expect(boot({ config, modules: [...modules, listy], pipelines: [...pipelines, listThenTag], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/listThenTag\] step "listy\.tag"'s extendsOutput cannot fold onto the active output schema: type "array", not "object" \(set by step "listy\.list"\)/,
    );
  });

  it("fails to boot when extendsOutput merges onto a union with a non-object branch", async () => {
    const mixed = defineModule({
      name: "mixed/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        pick: async (ctx: Context) => ok({ ...ctx, result: "x" }),
        tag: async (ctx: Context) => ok(ctx),
      }),
      describe: () => ({
        pick: { summary: "a union result", reads: [], writes: ["result"], output: { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "string" }] } },
        tag: { summary: "extends every branch with a tag", reads: [], writes: ["result.tag?"], extendsOutput: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } },
      }),
    });
    const pickThenTag = definePipeline({ name: "pickThenTag", steps: ["mixed.pick", "mixed.tag"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./mixed", config: {} }] };
    await expect(boot({ config, modules: [...modules, mixed], pipelines: [...pipelines, pickThenTag], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/pickThenTag\] step "mixed\.tag"'s extendsOutput cannot fold onto the active output schema: a union with a non-object branch/,
    );
  });

  it("fails to boot when extendsOutput's own extension is not an object schema", async () => {
    const arrayTag = defineModule({
      name: "arraytag/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ tag: async (ctx: Context) => ok({ ...ctx, result: ["a"] }) }),
      describe: () => ({ tag: { summary: "extends with a non-object extension", reads: [], writes: ["result"], extendsOutput: { type: "array", items: { type: "string" } } } }),
    });
    const tagOnly = definePipeline({ name: "tagOnly", steps: ["arraytag.tag"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./arraytag", config: {} }] };
    await expect(boot({ config, modules: [...modules, arrayTag], pipelines: [...pipelines, tagOnly], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/tagOnly\] step "arraytag\.tag"'s extendsOutput cannot fold onto the active output schema: the extension is not an object schema/,
    );
  });

  it("boots an extendsOutput that merges into every branch of an object-only union", async () => {
    const okUnion = defineModule({
      name: "okunion/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        pick: async (ctx: Context) => ok({ ...ctx, result: { a: "x" } }),
        tag: async (ctx: Context) => ok(ctx),
      }),
      describe: () => ({
        pick: { summary: "an object-only union result", reads: [], writes: ["result"], output: { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "string" } }, required: ["b"] }] } },
        tag: { summary: "extends every branch with a tag", reads: [], writes: ["result.tag?"], extendsOutput: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } },
      }),
    });
    const pickThenTag = definePipeline({ name: "pickThenTag", steps: ["okunion.pick", "okunion.tag"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./okunion", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, okUnion], pipelines: [...pipelines, pickThenTag], logger: silentLogger });
    expect([...kestrel.pipelines.keys()]).toContain("pickThenTag");
  });

  it("fails to boot when extendsItems merges onto a union with no list-shaped branch", async () => {
    const noList = defineModule({
      name: "nolist/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        pick: async (ctx: Context) => ok({ ...ctx, result: { a: "x" } }),
        tag: async (ctx: Context) => ok(ctx),
      }),
      describe: () => ({
        pick: { summary: "a union of plain objects", reads: [], writes: ["result"], output: { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "string" } }, required: ["b"] }] } },
        tag: { summary: "extendsItems onto a union with no list branch", reads: [], writes: ["result.tag?"], extendsItems: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } },
      }),
    });
    const pickThenTag = definePipeline({ name: "pickThenTag", steps: ["nolist.pick", "nolist.tag"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./nolist", config: {} }] };
    await expect(boot({ config, modules: [...modules, noList], pipelines: [...pipelines, pickThenTag], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/pickThenTag\] step "nolist\.tag"'s extendsItems cannot fold onto the active output schema: a union with no list-shaped branch/,
    );
  });

  it("fails to boot when extendsItems' root fallback lands on a non-object schema", async () => {
    const nonObject = defineModule({
      name: "nonobject/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        list: async (ctx: Context) => ok({ ...ctx, result: ["a", "b"] }),
        tag: async (ctx: Context) => ok(ctx),
      }),
      describe: () => ({
        list: { summary: "a plain list result", reads: [], writes: ["result"], output: { type: "array", items: { type: "string" } } },
        tag: { summary: "extendsItems root fallback onto a non-object", reads: [], writes: ["result.tag?"], extendsItems: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } },
      }),
    });
    const listThenTag = definePipeline({ name: "listThenTag2", steps: ["nonobject.list", "nonobject.tag"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./nonobject", config: {} }] };
    await expect(boot({ config, modules: [...modules, nonObject], pipelines: [...pipelines, listThenTag], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/listThenTag2\] step "nonobject\.tag"'s extendsItems cannot fold onto the active output schema: type "array", not "object" \(set by step "nonobject\.list"\)/,
    );
  });

  it("boots an extendsItems root fallback onto a single non-list object", async () => {
    const single = defineModule({
      name: "single/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        get: async (ctx: Context) => ok({ ...ctx, result: { id: "x" } }),
        attach: async (ctx: Context) => ok(ctx),
      }),
      describe: () => ({
        get: { summary: "a single item", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        attach: { summary: "extendsItems root fallback onto a single object", reads: [], writes: ["result.tag?"], extendsItems: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] } },
      }),
    });
    const getThenAttach = definePipeline({ name: "getThenAttach", steps: ["single.get", "single.attach"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./single", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, single], pipelines: [...pipelines, getThenAttach], logger: silentLogger });
    expect([...kestrel.pipelines.keys()]).toContain("getThenAttach");
  });

  it("fails to boot when a step declares terminalOutput without a write to result", async () => {
    const noWrite = defineModule({
      name: "nowrite/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ probe: async (ctx: Context) => ok(ctx) }),
      describe: () => ({ probe: { summary: "declares terminalOutput but writes nothing", reads: [], writes: [], terminalOutput: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } } }),
    });
    const probeOnly = definePipeline({ name: "probeOnly", steps: ["nowrite.probe"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./nowrite", config: {} }] };
    await expect(boot({ config, modules: [...modules, noWrite], pipelines: [...pipelines, probeOnly], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/probeOnly\] step "nowrite\.probe" declares terminalOutput without a write to result/,
    );
  });

  it("boots a step that declares terminalOutput with an optional result write", async () => {
    const withWrite = defineModule({
      name: "withwrite/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ probe: async (ctx: Context) => ctx.done({ done: true }) }),
      describe: () => ({ probe: { summary: "declares terminalOutput with an optional result write", reads: [], writes: ["result?"], terminalOutput: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } } }),
    });
    const probeOnly = definePipeline({ name: "probeOnly", steps: ["withwrite.probe"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./withwrite", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, withWrite], pipelines: [...pipelines, probeOnly], logger: silentLogger });
    expect([...kestrel.pipelines.keys()]).toContain("probeOnly");
  });

  it("treats terminalOutput with a mandatory result write and no output as undeclared output", async () => {
    const mandatory = defineModule({
      name: "mandatory/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ probe: async (ctx: Context) => ctx.done({ done: true }) }),
      describe: () => ({ probe: { summary: "always ends with a mandatory result write", reads: [], writes: ["result"], terminalOutput: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } } }),
    });
    const probeOnly = definePipeline({ name: "probeOnly", steps: ["mandatory.probe"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./mandatory", config: {} }] };
    await expect(boot({ config, modules: [...modules, mandatory], pipelines: [...pipelines, probeOnly], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/probeOnly\] step "mandatory\.probe" writes result without declaring output, extendsOutput, extendsItems or binary: true \(terminalOutput alone only covers an optional "result\?" write\)/,
    );
  });

  it("fails to boot when a pipeline combines terminalOutput with a binary step", async () => {
    const mixedBinary = defineModule({
      name: "mixedbinary/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        probe: async (ctx: Context) => ctx.done({ done: true }),
        serve: async (ctx: Context) => ok({ ...ctx, result: binaryResult(new Uint8Array([1]), "application/octet-stream") }),
      }),
      describe: () => ({
        probe: { summary: "declares terminalOutput", reads: [], writes: ["result?"], terminalOutput: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } },
        serve: { summary: "a binary step in the same pipeline", reads: [], writes: ["result"], binary: true },
      }),
    });
    const probeThenServe = definePipeline({ name: "probeThenServe", steps: ["mixedbinary.probe", "mixedbinary.serve"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./mixedbinary", config: {} }] };
    await expect(boot({ config, modules: [...modules, mixedBinary], pipelines: [...pipelines, probeThenServe], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/probeThenServe\] step "mixedbinary\.probe" declares terminalOutput in a pipeline with a binary step/,
    );
  });

  it("boots a pipeline with only a binary step and no terminalOutput step", async () => {
    const binaryOnly = defineModule({
      name: "binaryonly/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ serve: async (ctx: Context) => ok({ ...ctx, result: binaryResult(new Uint8Array([1]), "application/octet-stream") }) }),
      describe: () => ({ serve: { summary: "a lone binary step", reads: [], writes: ["result"], binary: true } }),
    });
    const serveOnly = definePipeline({ name: "serveOnly", steps: ["binaryonly.serve"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./binaryonly", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, binaryOnly], pipelines: [...pipelines, serveOnly], logger: silentLogger });
    expect([...kestrel.pipelines.keys()]).toContain("serveOnly");
  });

  it("fails to boot for a terminalOutput object schema that declares properties without required", async () => {
    const looseTerminal = defineModule({
      name: "looseterminal/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ probe: async (ctx: Context) => ctx.done({ redirect: { to: "/x" } }) }),
      describe: () => ({
        probe: {
          summary: "terminalOutput with a nested object missing required",
          reads: [],
          writes: ["result?"],
          terminalOutput: { type: "object", properties: { redirect: { type: "object", properties: { to: { type: "string" } } } }, required: ["redirect"] },
        },
      }),
    });
    const probeOnly = definePipeline({ name: "probeOnly", steps: ["looseterminal.probe"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./looseterminal", config: {} }] };
    await expect(boot({ config, modules: [...modules, looseTerminal], pipelines: [...pipelines, probeOnly], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/probeOnly\] step "looseterminal\.probe"'s output schema at \$\.terminalOutput\.properties\.redirect declares properties without declaring required/,
    );
  });

  it("boots when the nested terminalOutput schema declares required throughout", async () => {
    const okTerminal = defineModule({
      name: "okterminal/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ probe: async (ctx: Context) => ctx.done({ redirect: { to: "/x" } }) }),
      describe: () => ({
        probe: {
          summary: "terminalOutput with required declared throughout",
          reads: [],
          writes: ["result?"],
          terminalOutput: { type: "object", properties: { redirect: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } }, required: ["redirect"] },
        },
      }),
    });
    const probeOnly = definePipeline({ name: "probeOnly", steps: ["okterminal.probe"] });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./okterminal", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, okTerminal], pipelines: [...pipelines, probeOnly], logger: silentLogger });
    expect([...kestrel.pipelines.keys()]).toContain("probeOnly");
  });

  it("warns once for an optional read whose key no step of any pipeline writes and no trigger provides", async () => {
    const guesser = defineModule({
      name: "guesser/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: { id: "x" } }) }),
      describe: () => ({ create: { summary: "reads a key nothing writes", reads: ["verifiedUsr?"], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } }),
    });
    const guesserCreate = definePipeline({ name: "guesserCreate", steps: ["guesser.create"] });
    const warnings: { message: string; data: Record<string, unknown> | undefined }[] = [];
    const logger = { ...silentLogger, warn: (message: string, data?: Record<string, unknown>) => warnings.push({ message, data }) };
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./guesser", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, guesser], pipelines: [...pipelines, guesserCreate], logger });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/step optionally reads "verifiedUsr" but no registered step writes it and no trigger provides it/);
    expect(warnings[0]?.data).toEqual({ pipeline: "guesserCreate", step: "guesser.create", key: "verifiedUsr" });
    expect(kestrel.warnings).toEqual([{ code: "unwritten-optional-read", message: warnings[0]?.message, pipeline: "guesserCreate", step: "guesser.create", key: "verifiedUsr" }]);
  });

  it("stays quiet for an optional read whose key a registered step writes, even when that step is not used by any booted pipeline", async () => {
    const feature = defineModule({
      name: "feature/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({
        write: async (ctx: Context) => ok({ ...ctx, result: "sidecar-value" }),
        read: async (ctx: Context) => ok({ ...ctx, result: typeof ctx.result === "string" ? ctx.result : null }),
      }),
      describe: () => ({
        write: { summary: "writes the sidecar result; no pipeline below uses this step", reads: [], writes: ["result"], output: { type: "string" } },
        read: { summary: "reads the sidecar result if an earlier feature pipeline set it", reads: ["result?"], writes: ["result"], output: { type: ["string", "null"] } },
      }),
    });
    const featureRead = definePipeline({ name: "featureRead", steps: ["feature.read"] });
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./feature", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, feature], pipelines: [...pipelines, featureRead], logger });
    expect(warnings).toEqual([]);
    expect(kestrel.warnings).toEqual([]);
  });

  it("stays quiet for an optional read of a key the runner always provides (body, query, requestId, runId, trigger)", async () => {
    const runnerKeys = defineModule({
      name: "runnerkeys/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ create: async (ctx: Context) => ok({ ...ctx, result: { id: "x" } }) }),
      describe: () => ({
        create: {
          summary: "reads several runner-provided keys optionally",
          reads: ["body?", "query?", "requestId?", "runId?", "trigger?"],
          writes: ["result"],
          output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }),
    });
    const runnerKeysCreate = definePipeline({ name: "runnerKeysCreate", steps: ["runnerkeys.create"] });
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./runnerkeys", config: {} }] };
    kestrel = await boot({ config, modules: [...modules, runnerKeys], pipelines: [...pipelines, runnerKeysCreate], logger });
    expect(warnings).toEqual([]);
    expect(kestrel.warnings).toEqual([]);
  });

  it("stays quiet when a pipeline emits the event, whatever the emit step's query tail", async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const archive = definePipeline({ name: "archivePage", steps: ["store.create:pages", "events.emit:page.archived?with=result"] });
    kestrel = await boot({ config: { ...baseConfig, triggers: [{ event: "page.archived", pipeline: "onCreated" }] }, modules, pipelines: [...pipelines, archive], logger });
    expect(warnings).toEqual([]);
    expect(kestrel.warnings).toEqual([]);
  });

  it("stays quiet when a module declares the event in emits", async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const migrations = defineModule({
      name: "migrations/fake",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      emits: ["migrations.applied"],
      async setup(): Promise<null> {
        return null;
      },
    });
    const config = { ...baseConfig, modules: [...baseConfig.modules, { use: "./migrations", config: {} }], triggers: [{ event: "migrations.applied", pipeline: "onCreated" }] };
    kestrel = await boot({ config, modules: [...modules, migrations], pipelines, logger });
    expect(warnings).toEqual([]);
    expect(kestrel.warnings).toEqual([]);
  });

  it("http: null keeps the routes for adapters but serves nothing", async () => {
    kestrel = await boot({ config: { ...baseConfig, http: null }, modules, pipelines, logger: silentLogger });
    expect(kestrel.triggers.http.map((r) => r.pipeline)).toEqual(["createPage", "readPage", "whoami", "upload", "download"]);
    expect(await kestrel.start()).toEqual({});
    const res = await kestrel.run("readPage", { trigger: { kind: "http", name: "embedded" }, params: { id: "nope" } });
    expect(res.status).toBe(404);
  });

  it("event triggers without a module offering the hook are a boot error", async () => {
    const config = { modules: [{ use: "./store", config: { file: "x" } }], triggers: [{ event: "e", pipeline: "readPage" }] };
    await expect(boot({ config, modules: [store], pipelines: [readPage], logger: silentLogger })).rejects.toThrow(/event triggers need a module that provides an event trigger hook/);
  });

  it("a foreign events@1 without the hook fails at boot, not with a TypeError in start()", async () => {
    interface Broker {
      publish(name: string, data: Record<string, unknown>): Promise<void>;
      subscribe(name: string, handler: Handler): () => void;
    }
    const BROKER = defineContract<Broker>()("events@1", ["publish", "subscribe"]);
    const broker = defineModule({
      name: "events/broker",
      provides: [BROKER],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<Broker> {
        return { async publish() {}, subscribe: () => () => {} };
      },
    });
    const config = { modules: [{ use: "./broker", config: {} }, { use: "./store", config: { file: "x" } }], triggers: [{ event: "e", pipeline: "readPage" }] };
    await expect(boot({ config, modules: [broker, store], pipelines: [readPage], logger: silentLogger })).rejects.toThrow(
      /event triggers need a module that provides an event trigger hook/,
    );
  });

  it("two modules offering the hook are a boot error naming both", async () => {
    const second = defineModule({
      name: "events/second",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      triggers: { event: () => () => {} },
    });
    const config = { modules: [{ use: "./events", config: {} }, { use: "./second", config: {} }], triggers: [] };
    const error = await boot({ config, modules: [events, second], pipelines: [], logger: silentLogger }).catch((err: unknown) => err);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/both provide an event trigger hook/);
    expect(message).toContain("events/fake");
    expect(message).toContain("events/second");
  });

  it("two modules both registering events.emit fail at step registration, naming the second owner", async () => {
    const direct = defineModule({
      name: "events/direct",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      triggers: { event: () => () => {} },
      steps: () => ({ emit: async (ctx: Context) => ok(ctx) }),
      describe: () => ({ emit: { summary: "emit", reads: [], writes: [] } }),
    });
    const queueLike = defineModule({
      name: "events/queue",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        return null;
      },
      steps: () => ({ emit: async (ctx: Context) => ok(ctx) }),
      describe: () => ({ emit: { summary: "emit", reads: [], writes: [] } }),
    });
    const config = { modules: [{ use: "./direct", config: {} }, { use: "./queue", config: {} }], triggers: [] };
    await expect(boot({ config, modules: [direct, queueLike], pipelines: [], logger: silentLogger })).rejects.toThrow(
      '[events/queue] step "events.emit" is already registered by events/direct',
    );
  });

  it("a pipeline using events.emit without a delivery module fails to resolve", async () => {
    const useEmit = definePipeline({ name: "useEmit", steps: ["events.emit:x"] });
    const config = { modules: [{ use: "./store", config: { file: "x" } }], triggers: [] };
    await expect(boot({ config, modules: [store], pipelines: [useEmit], logger: silentLogger })).rejects.toThrow('[pipelines/useEmit] unknown step "events.emit"');
  });

  it("validates cron expressions at boot", async () => {
    await expect(boot({ config: { ...baseConfig, triggers: [{ cron: "x y", pipeline: "onCreated" }] }, modules, pipelines, logger: silentLogger })).rejects.toThrow(/5 fields/);
    kestrel = await boot({ config: { ...baseConfig, triggers: [{ cron: "0 3 * * *", pipeline: "onCreated" }] }, modules, pipelines, logger: silentLogger });
    await kestrel.start();
  });

  it("rejects a pipeline whose step reads what only an optional write may provide", async () => {
    const bad = definePipeline({ name: "bad", steps: ["auth.identifyUser", "auth.loadIdentity"] });
    await expect(boot({ config: { ...baseConfig, triggers: [] }, modules, pipelines: [bad], logger: silentLogger })).rejects.toThrow(
      /\[pipelines\/bad\] step "auth.loadIdentity" reads "identity" but no earlier step writes it \(earlier writes: none\)/,
    );
  });

  it("accepts the same pipeline when an earlier step writes it unconditionally", async () => {
    const fine = definePipeline({ name: "fine", steps: ["auth.requireUser", "auth.loadIdentity"] });
    kestrel = await boot({ config: { ...baseConfig, triggers: [] }, modules, pipelines: [fine], logger: silentLogger });
    expect([...kestrel.pipelines.keys()]).toEqual(["fine"]);
  });

  it("rejects a params read in a cron-only pipeline and accepts it under an event trigger", async () => {
    const cron = { ...baseConfig, triggers: [{ cron: "0 3 * * *", pipeline: "readPage" }] };
    await expect(boot({ config: cron, modules, pipelines: [readPage], logger: silentLogger })).rejects.toThrow(/step "store.findOne:pages" reads "params.id"/);
    const event = { ...baseConfig, triggers: [{ event: "page.created", pipeline: "readPage" }] };
    kestrel = await boot({ config: event, modules, pipelines: [readPage], logger: silentLogger });
    expect(kestrel.triggers.events).toEqual([{ event: "page.created", pipeline: "readPage" }]);
  });

  it("rejects a params read no http route of the pipeline binds", async () => {
    const triggers = [{ http: "GET /pages", pipeline: "readPage" }];
    await expect(boot({ config: { ...baseConfig, triggers }, modules, pipelines: [readPage], logger: silentLogger })).rejects.toThrow(/step "store.findOne:pages" reads "params.id"/);
  });

  it("module config is validated by its schema", async () => {
    const config = { ...baseConfig, modules: [{ use: "./guard", config: {} }, { use: "./auth", config: {} }, { use: "./store", config: { file: 42 } }, { use: "./events", config: {} }] };
    await expect(boot({ config, modules, pipelines: [], logger: silentLogger })).rejects.toThrow(new KestrelBootError("store/memory", "invalid config: file: Expected string, received number", "invalid-module-config"));
  });

  it("missing provider names module and contract", async () => {
    const config = { modules: [{ use: "./auth", config: {} }], triggers: [] };
    await expect(boot({ config, modules: [auth], pipelines: [], logger: silentLogger })).rejects.toThrow(/\[auth\/fake\] requires "store@1"/);
  });

  it("setup result missing a contract method is a boot error", async () => {
    const broken = defineModule({ name: "guard/broken", provides: [GUARD], requires: [], configSchema: z.object({}), async setup() { return {}; } });
    const config = { modules: [{ use: "./broken" }], triggers: [] };
    await expect(boot({ config, modules: [broken], pipelines: [], logger: silentLogger })).rejects.toThrow(/lacks guard@1 method\(s\): can/);
  });

  it("unknown step in a pipeline is a boot error", async () => {
    const bad = definePipeline({ name: "bad", steps: ["auth.requireUser", "mailer.send"] });
    await expect(boot({ config: { ...baseConfig, triggers: [] }, modules, pipelines: [bad], logger: silentLogger })).rejects.toThrow(/\[pipelines\/bad\] unknown step "mailer.send"/);
  });

  it("trigger to unknown pipeline is a boot error", async () => {
    await expect(boot({ config: { ...baseConfig, triggers: [{ http: "GET /x", pipeline: "nope" }] }, modules, pipelines: [], logger: silentLogger })).rejects.toThrow(/unknown pipeline "nope"/);
  });

  it("invalid kestrel.config is a boot error", async () => {
    await expect(boot({ config: { modules: [], triggers: [{ http: "FETCH /x", pipeline: "p" }] }, modules: [], pipelines: [], logger: silentLogger })).rejects.toThrow(KestrelBootError);
  });

  it("a module listed twice is a boot error", async () => {
    const config = { modules: [{ use: "./store", config: { file: "a" } }, { use: "./store", config: { file: "b" } }], triggers: [] };
    await expect(boot({ config, modules: [store, store], pipelines: [], logger: silentLogger })).rejects.toThrow(/listed twice/);
  });

  it("passes deps.logger to setup", async () => {
    let seen: unknown;
    const spy = defineModule({
      name: "spy/logger",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps) {
        seen = deps.logger;
        return {};
      },
    });
    kestrel = await boot({ config: { modules: [{ use: "./spy", config: {} }], triggers: [] }, modules: [spy], pipelines: [], logger: silentLogger });
    expect(seen).toBe(silentLogger);
  });

  it("deps.find returns the instance when provided and undefined when not", async () => {
    let found: unknown;
    const spy = defineModule({
      name: "spy/find",
      provides: [],
      requires: [],
      optional: [STORE],
      configSchema: z.object({}).strict(),
      async setup(_config, deps) {
        found = deps.find(STORE);
        return {};
      },
    });
    kestrel = await boot({
      config: { modules: [{ use: "./store", config: { file: ":memory:" } }, { use: "./find", config: {} }], triggers: [] },
      modules: [store, spy],
      pipelines: [],
      logger: silentLogger,
    });
    expect(found).toBe(kestrel.contracts.get(STORE));
    await kestrel.stop();
    kestrel = undefined;

    let foundNothing: unknown = "unset";
    const spyAlone = defineModule({
      name: "spy/find",
      provides: [],
      requires: [],
      optional: [STORE],
      configSchema: z.object({}).strict(),
      async setup(_config, deps) {
        foundNothing = deps.find(STORE);
        return {};
      },
    });
    kestrel = await boot({ config: { modules: [{ use: "./find", config: {} }], triggers: [] }, modules: [spyAlone], pipelines: [], logger: silentLogger });
    expect(foundNothing).toBeUndefined();
  });

  it("passes deps.root to setup, defaulting to process.cwd()", async () => {
    let seen: unknown;
    const spy = defineModule({
      name: "spy/root",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps) {
        seen = deps.root;
        return {};
      },
    });
    kestrel = await boot({ config: { modules: [{ use: "./spy", config: {} }], triggers: [] }, modules: [spy], pipelines: [], logger: silentLogger });
    expect(seen).toBe(process.cwd());

    let seenExplicit: unknown;
    const spyExplicit = defineModule({
      name: "spy/root-explicit",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps) {
        seenExplicit = deps.root;
        return {};
      },
    });
    kestrel = await boot({ config: { modules: [{ use: "./spy", config: {} }], triggers: [] }, modules: [spyExplicit], pipelines: [], logger: silentLogger, root: "/tmp/custom-root" });
    expect(seenExplicit).toBe("/tmp/custom-root");
  });

  it("calls teardown for every module with one, in reverse boot order, on stop()", async () => {
    const order: string[] = [];
    const makeModule = (name: string) =>
      defineModule({
        name,
        provides: [],
        requires: [],
        configSchema: z.object({}).strict(),
        async setup() {
          return {};
        },
        teardown() {
          order.push(name);
        },
      });
    const first = makeModule("teardown/first");
    const second = makeModule("teardown/second");
    kestrel = await boot({
      config: { modules: [{ use: "./first", config: {} }, { use: "./second", config: {} }], triggers: [] },
      modules: [first, second],
      pipelines: [],
      logger: silentLogger,
    });
    await kestrel.stop();
    expect(order).toEqual(["teardown/second", "teardown/first"]);
    await kestrel.stop();
    expect(order).toEqual(["teardown/second", "teardown/first"]);
  });

  it("logs a throwing teardown and still runs the remaining ones", async () => {
    const order: string[] = [];
    const errors: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const logger = { ...silentLogger, error: (message: string, data?: Record<string, unknown>) => errors.push(data === undefined ? { message } : { message, data }) };
    const fine = defineModule({
      name: "teardown/ok",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      teardown() {
        order.push("ok");
      },
    });
    const broken = defineModule({
      name: "teardown/broken",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      teardown() {
        throw new Error("boom");
      },
    });
    kestrel = await boot({
      config: { modules: [{ use: "./ok", config: {} }, { use: "./broken", config: {} }], triggers: [] },
      modules: [fine, broken],
      pipelines: [],
      logger,
    });
    await kestrel.stop();
    expect(order).toEqual(["ok"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/teardown\/broken/);
  });

  it("runs teardowns and still rejects when closing the http server fails", async () => {
    const order: string[] = [];
    const mod = defineModule({
      name: "teardown/http",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ ping: async (ctx: Context) => ok({ ...ctx, result: "pong" }) }),
      describe: () => ({ ping: { summary: "answer with pong", reads: [], writes: ["result"], output: { type: "string" } } }),
      teardown() {
        order.push("teardown/http");
      },
    });
    const ping = definePipeline({ name: "ping", steps: ["teardown.ping"] });
    const closeSpy = vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, cb?: (err?: Error) => void) {
      cb?.(new Error("close boom"));
      return this;
    });
    kestrel = await boot({
      config: { modules: [{ use: "./http", config: {} }], triggers: [{ http: "GET /x", pipeline: "ping" }], http: { port: 0 } },
      modules: [mod],
      pipelines: [ping],
      logger: silentLogger,
    });
    await kestrel.start();
    await expect(kestrel.stop()).rejects.toThrow("close boom");
    expect(order).toEqual(["teardown/http"]);
    closeSpy.mockRestore();
  });

  it("tears down already-constructed modules when boot fails after the first successful setup", async () => {
    const order: string[] = [];
    const first = defineModule({
      name: "teardown/one",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      teardown() {
        order.push("teardown/one");
      },
    });
    const second = defineModule({
      name: "teardown/two",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        throw new Error("setup boom");
      },
    });
    await expect(
      boot({
        config: { modules: [{ use: "./one", config: {} }, { use: "./two", config: {} }], triggers: [] },
        modules: [first, second],
        pipelines: [],
        logger: silentLogger,
      }),
    ).rejects.toThrow(/\[teardown\/two\] setup\(\) threw: setup boom/);
    expect(order).toEqual(["teardown/one"]);
  });

  it("tears down already-constructed modules when a later boot stage fails (invalid trigger)", async () => {
    const order: string[] = [];
    const mod = defineModule({
      name: "teardown/trigger",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ ping: async (ctx: Context) => ok({ ...ctx, result: "pong" }) }),
      describe: () => ({ ping: { summary: "answer with pong", reads: [], writes: ["result"], output: { type: "string" } } }),
      teardown() {
        order.push("teardown/trigger");
      },
    });
    const ping = definePipeline({ name: "ping", steps: ["teardown.ping"] });
    await expect(
      boot({
        config: { modules: [{ use: "./trigger", config: {} }], triggers: [{ http: "GET //bad", pipeline: "ping" }] },
        modules: [mod],
        pipelines: [ping],
        logger: silentLogger,
      }),
    ).rejects.toThrow(KestrelBootError);
    expect(order).toEqual(["teardown/trigger"]);
  });

  it("waits for an in-flight run before tearing modules down, then reports drained", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mod = defineModule({
      name: "slow/step",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({
        wait: async (ctx: Context) => {
          await gate;
          order.push("run");
          return ok(ctx);
        },
      }),
      describe: () => ({ wait: { summary: "wait for the gate", reads: [], writes: [] } }),
      teardown() {
        order.push("teardown");
      },
    });
    kestrel = await boot({
      config: { modules: [{ use: "./slow", config: {} }], triggers: [{ http: "GET /x", pipeline: "slow" }], http: { port: 0 } },
      modules: [mod],
      pipelines: [definePipeline({ name: "slow", steps: ["slow.wait"] })],
      logger: silentLogger,
    });
    await kestrel.start();
    const running = kestrel.run("slow", { trigger: { kind: "http", name: "GET /x" } });
    const stopping = kestrel.stop({ timeoutMs: 5_000 });
    release();
    await running;
    expect(await stopping).toEqual({ drained: true });
    expect(order).toEqual(["run", "teardown"]);
  });

  it("gives up on a run that outlives the shutdown deadline and reports it", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mod = defineModule({
      name: "stuck/step",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ wait: async (ctx: Context) => { await gate; return ok(ctx); } }),
      describe: () => ({ wait: { summary: "wait for the gate", reads: [], writes: [] } }),
    });
    kestrel = await boot({
      config: { modules: [{ use: "./stuck", config: {} }], triggers: [], http: null },
      modules: [mod],
      pipelines: [definePipeline({ name: "stuck", steps: ["stuck.wait"] })],
      logger: silentLogger,
    });
    const running = kestrel.run("stuck", { trigger: { kind: "cron", name: "* * * * *" } });
    expect(await kestrel.stop({ timeoutMs: 20 })).toEqual({ drained: false });
    release();
    await running;
  });

  it("stops cron and event triggers only after the in-flight runs are drained", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mod = defineModule({
      name: "ordered/step",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ wait: async (ctx: Context) => { await gate; order.push("run"); return ok(ctx); } }),
      describe: () => ({ wait: { summary: "wait for the gate", reads: [], writes: [] } }),
      triggers: {
        event: () => () => {
          order.push("unsubscribe");
        },
      },
    });
    kestrel = await boot({
      config: { modules: [{ use: "./ordered", config: {} }], triggers: [{ event: "page.created", pipeline: "ordered" }], http: null },
      modules: [mod],
      pipelines: [definePipeline({ name: "ordered", steps: ["ordered.wait"] })],
      logger: silentLogger,
    });
    await kestrel.start();
    const running = kestrel.run("ordered", { trigger: { kind: "event", name: "page.created" } });
    const stopping = kestrel.stop({ timeoutMs: 5_000 });
    release();
    await running;
    await stopping;
    expect(order).toEqual(["run", "unsubscribe"]);
  });

  it("serves a request that arrives just before stop() instead of cutting the connection", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mod = defineModule({
      name: "draining/step",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return {};
      },
      steps: () => ({ wait: async (ctx: Context) => { await gate; return ok({ ...ctx, result: { ok: true } }); } }),
      describe: () => ({ wait: { summary: "wait for the gate", reads: [], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }),
    });
    kestrel = await boot({
      config: { modules: [{ use: "./draining", config: {} }], triggers: [{ http: "GET /slow", pipeline: "draining" }], http: { port: 0 } },
      modules: [mod],
      pipelines: [definePipeline({ name: "draining", steps: ["draining.wait"] })],
      logger: silentLogger,
    });
    const { http } = await kestrel.start();
    const pending = fetch(`http://127.0.0.1:${http?.port ?? 0}/slow`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopping = kestrel.stop({ timeoutMs: 5_000 });
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await stopping).toEqual({ drained: true });
  });

  it("reports a body that does not match describe().input as VALIDATION in every environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    kestrel = await bootTyped();
    const res = await runTyped(kestrel, { title: 42 });
    expect(res).toMatchObject({ status: 400, code: "VALIDATION", retryable: false, step: "typed.create", details: { problems: [{ path: "$.title", message: "expected string, got number" }] } });
    expect(res.error).toBe("typed.create: payload does not match schema ($.title expected string, got number)");
  });

  it("checks declared query parameters on a coerced copy and rejects undeclared body keys", async () => {
    kestrel = await bootTyped();
    expect(await runTyped(kestrel, { title: "x" }, { limit: "3" })).toMatchObject({ status: 200, result: "x" });
    expect(await runTyped(kestrel, { title: "x" }, { limit: "x" })).toMatchObject({ status: 400, code: "VALIDATION", details: { problems: [{ path: "$.limit", message: "expected integer, got string" }] } });
    const res = await runTyped(kestrel, { title: "x", nope: 1 });
    expect(res.details).toEqual({ problems: [{ path: "$.nope", message: "is not allowed by additionalProperties: false" }] });
  });

  describe("before reorders setup", () => {
    const DB = defineContract<{ open(): void }>()("db@1", ["open"]);

    const setupOrder: string[] = [];

    const dbModule = defineModule({
      name: "db/store",
      provides: [DB],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(): Promise<{ open(): void }> {
        setupOrder.push("db/store");
        return { open() {} };
      },
    });
    const consumerModule = defineModule({
      name: "feature/x",
      provides: [],
      requires: [DB],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        setupOrder.push("feature/x");
        return null;
      },
    });
    const restoreModule = defineModule({
      name: "restore/r",
      provides: [],
      requires: [],
      before: [DB],
      configSchema: z.object({}).strict(),
      async setup(): Promise<null> {
        setupOrder.push("restore/r");
        return null;
      },
    });

    beforeEach(() => {
      setupOrder.length = 0;
    });

    it("sets up a module declaring before ahead of the module providing the contract it names, listed order notwithstanding", async () => {
      const config = { modules: [{ use: "./db" }, { use: "./r" }], triggers: [], http: null };
      kestrel = await boot({ config, modules: [dbModule, restoreModule], pipelines: [], logger: silentLogger });
      expect(setupOrder).toEqual(["restore/r", "db/store"]);
      expect(kestrel.warnings).toEqual([]);
    });

    it("still reorders when a consumer listed between the restore module and its provider would otherwise pull the provider forward", async () => {
      const config = { modules: [{ use: "./x" }, { use: "./r" }, { use: "./db" }], triggers: [], http: null };
      kestrel = await boot({ config, modules: [consumerModule, restoreModule, dbModule], pipelines: [], logger: silentLogger });
      expect(setupOrder.indexOf("restore/r")).toBeLessThan(setupOrder.indexOf("db/store"));
      expect(kestrel.warnings).toEqual([]);
    });

    it("fails boot with the cycle path when the provider of the named contract depends on the declaring module transitively", async () => {
      const BLOBSTORE = defineContract<{ read(): void }>()("blobstore@1", ["read"]);
      const blobstoreModule = defineModule({
        name: "blobstore/consumer",
        provides: [BLOBSTORE],
        requires: [DB],
        configSchema: z.object({}).strict(),
        async setup(): Promise<{ read(): void }> {
          return { read() {} };
        },
      });
      const dependentRestoreModule = defineModule({
        name: "restore/dependent",
        provides: [],
        requires: [BLOBSTORE],
        before: [DB],
        configSchema: z.object({}).strict(),
        async setup(): Promise<null> {
          return null;
        },
      });
      const config = { modules: [{ use: "./db" }, { use: "./blobstore" }, { use: "./restore" }], triggers: [], http: null };
      await expect(boot({ config, modules: [dbModule, blobstoreModule, dependentRestoreModule], pipelines: [], logger: silentLogger })).rejects.toThrow(
        new KestrelBootError("db/store", "dependency cycle: db/store -> restore/dependent -> blobstore/consumer -> db/store", "dependency-cycle"),
      );
    });
  });
});
