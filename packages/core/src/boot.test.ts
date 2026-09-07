import { Server } from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { boot, type Kestrel } from "./boot.ts";
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
      return ok({ ...ctx, result: binaryResult(new Uint8Array(doc.data as number[]), doc.contentType as string, ctx.params.name) });
    },
    log: stepFactory((collection: string) => async (ctx: Context) => {
      await db.put(collection, String(ctx.payload.at), ctx.payload);
      return ok(ctx);
    }),
  }),
  describe: () => ({
    create: (collection: string) => ({ summary: `create a ${collection} document`, reads: [], writes: ["result"] }),
    findOne: (collection: string) => ({ summary: `read a ${collection} document`, reads: ["params.id"], writes: ["result"] }),
    upload: { summary: "store an uploaded file", reads: ["files"], writes: ["result"] },
    download: { summary: "serve a stored file", reads: ["params.name"], writes: ["result"] },
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
    loadIdentity: { summary: "return the resolved identity", reads: ["identity"], writes: ["result"] },
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
  describe: () => ({ loop: { summary: "produce a circular result", reads: [], writes: ["result"] } }),
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
const bootTyped = (dev?: boolean) =>
  boot({ config: typedConfig, modules: [typed], pipelines: [typedPipeline], logger: silentLogger, ...(dev === undefined ? {} : { dev }) });
const runTyped = (instance: Kestrel, payload: Record<string, unknown>) => instance.run("typed", { trigger: { kind: "http", name: "POST /typed" }, payload });

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
    expect(await (await fetch(`${base}/pages/nope`)).json()).toMatchObject({ error: expect.stringContaining("not found") as string, runId: expect.any(String) as string });

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
      describe: () => ({ record: { summary: "record the client ip", reads: ["ip"], writes: ["result"] } }),
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
    expect((error as Error).message).toMatch(/both provide an event trigger hook/);
    expect((error as Error).message).toContain("events/fake");
    expect((error as Error).message).toContain("events/second");
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
    await expect(boot({ config, modules, pipelines: [], logger: silentLogger })).rejects.toThrow(new KestrelBootError("store/memory", "invalid config: file: Expected string, received number"));
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
      describe: () => ({ ping: { summary: "answer with pong", reads: [], writes: ["result"] } }),
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
      describe: () => ({ ping: { summary: "answer with pong", reads: [], writes: ["result"] } }),
      teardown() {
        order.push("teardown/trigger");
      },
    });
    const ping = definePipeline({ name: "ping", steps: ["teardown.ping"] });
    // "GET //bad" clears the top-level config regex (method + non-whitespace path) but fails
    // inside parseRoute() on the empty path segment, i.e. after module setup already ran.
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
      describe: () => ({ wait: { summary: "wait for the gate", reads: [], writes: ["result"] } }),
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

  it("dev mode reports a payload that does not match describe().input as INTERNAL", async () => {
    kestrel = await bootTyped(true);
    const res = await runTyped(kestrel, { title: 42 });
    expect(res).toMatchObject({ status: 500, code: "INTERNAL", retryable: false, step: "typed.create" });
    expect(res.error).toBe('dev: payload of step "typed.create" in pipeline "typed" does not match describe().input at $.title: expected string, got number');
  });

  it("dev mode merges the query parameters into the validated payload", async () => {
    kestrel = await bootTyped(true);
    expect(await runTyped(kestrel, { title: "x", limit: 3 })).toMatchObject({ status: 200, result: "x" });
    const res = await runTyped(kestrel, { title: "x", nope: 1 });
    expect(res.error).toContain("at $.nope: is not allowed by additionalProperties: false");
  });

  it("boot({ dev: false }) skips the validation entirely", async () => {
    kestrel = await bootTyped(false);
    expect(await runTyped(kestrel, { title: 42 })).toMatchObject({ status: 200, result: 42 });
  });

  it("dev defaults to NODE_ENV !== production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    kestrel = await bootTyped();
    expect(await runTyped(kestrel, { title: 42 })).toMatchObject({ status: 200, result: 42 });
    await kestrel.stop();

    vi.stubEnv("NODE_ENV", "development");
    kestrel = await bootTyped();
    expect(await runTyped(kestrel, { title: 42 })).toMatchObject({ status: 500, code: "INTERNAL" });
  });
});
