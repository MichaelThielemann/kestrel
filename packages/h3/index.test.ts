import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, eventHandler, toNodeListener } from "h3";
import { afterEach, describe, it, expect } from "vitest";
import { z } from "zod";
import { binaryResult, boot, customFailure, defineContract, defineModule, definePipeline, ok, silentLogger, type Context, type Kestrel } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createKestrelHandler, routedPipeline } from "./index.ts";

async function jsonBody<T>(res: Response): Promise<T> {
  return boundaryCast<T>(await res.json(), "json");
}

interface Store {
  put(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
}
const STORE = defineContract<Store>()("store@1", ["put", "get"]);
const store = defineModule({
  name: "store/memory",
  provides: [STORE],
  requires: [],
  configSchema: z.object({}),
  async setup(): Promise<Store> {
    const m = new Map<string, unknown>();
    return { async put(k, v) { m.set(k, v); }, async get(k) { return m.get(k) ?? null; } };
  },
  steps: (db) => ({
    echo: async (ctx: Context) => ok({ ...ctx, result: { payload: ctx.payload, params: ctx.params, ip: ctx.ip ?? null, auth: ctx.headers.authorization ?? null } }),
    save: async (ctx: Context) => ok({ ...ctx, result: { role: ctx.payload.role ?? null } }),
    fail: async (ctx: Context) => ctx.fail(customFailure("TEAPOT", 418, "teapot", { details: { pot: true } })),
    greet: async (ctx: Context) => ok({ ...ctx, responseHeaders: { "set-cookie": "greeting=hello; HttpOnly; Path=/" }, responseCookies: ["visit=1; HttpOnly; Path=/"], result: { ok: true } }),
    upload: async (ctx: Context) => {
      const file = ctx.files[0];
      if (!file) return ctx.fail("VALIDATION", "no file");
      await db.put(file.filename, { contentType: file.contentType, data: [...file.data], note: ctx.payload.note });
      return ok({ ...ctx, result: { filename: file.filename, size: file.data.byteLength } });
    },
    download: async (ctx: Context) => {
      const doc = boundaryCast<{ contentType: string; data: number[] } | null>(await db.get(ctx.params.name ?? ""), "host");
      if (!doc) return ctx.fail("NOT_FOUND", "no such file");
      return ok({ ...ctx, result: binaryResult(new Uint8Array(doc.data), doc.contentType, ctx.params.name) });
    },
  }),
  describe: () => ({
    echo: { summary: "Echoes payload, params, ip and the authorization header.", reads: ["payload", "params", "ip", "headers.authorization"], writes: ["result"], output: { type: "object" } },
    save: { summary: "Answers the role of the payload.", reads: ["payload.role?"], writes: ["result"], input: { type: "object", properties: { role: { type: "string" } }, additionalProperties: false }, output: { type: "object" } },
    fail: { summary: "Always fails with a teapot error.", reads: [], writes: [] },
    greet: { summary: "Sets two cookies on the response.", reads: [], writes: ["responseHeaders", "responseCookies", "result"], output: { type: "object" } },
    upload: { summary: "Stores an uploaded file.", reads: ["files", "payload.note"], writes: ["result"], output: { type: "object", properties: { filename: { type: "string" }, size: { type: "number" } }, required: ["filename", "size"] } },
    download: { summary: "Serves a stored file as a binary result.", reads: ["params.name"], writes: ["result"], binary: true },
  }),
});

const config = {
  modules: [{ use: "./store", config: {} }],
  triggers: [
    { http: "GET /echo/:id", pipeline: "echo" },
    { http: "POST /echo", pipeline: "echo" },
    { http: "POST /save", pipeline: "save" },
    { http: "GET /fail", pipeline: "fail" },
    { http: "POST /greet", pipeline: "greet" },
    { http: "POST /files", pipeline: "upload" },
    { http: "GET /files/:name", pipeline: "download" },
    { http: "GET /site/*path", pipeline: "echo" },
  ],
  http: null,
};
const pipelines = [
  definePipeline({ name: "echo", steps: ["store.echo"] }),
  definePipeline({ name: "save", steps: ["store.save"] }),
  definePipeline({ name: "fail", steps: ["store.fail"] }),
  definePipeline({ name: "greet", steps: ["store.greet"] }),
  definePipeline({ name: "upload", steps: ["store.upload"] }),
  definePipeline({ name: "download", steps: ["store.download"] }),
];

let kestrel: Kestrel | undefined;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  await kestrel?.stop();
});

async function serve(options: Parameters<typeof createKestrelHandler>[1] = {}) {
  kestrel = await boot({ config, modules: [store], pipelines, logger: silentLogger });
  await kestrel.start();
  const app = createApp();
  app.use(createKestrelHandler(kestrel, options));
  const server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return `http://127.0.0.1:${boundaryCast<AddressInfo>(server.address(), "host").port}`;
}

function rawGet(base: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/`, { path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("kestrel-h3", () => {
  it("answers 400 to a path with a dot segment instead of routing the resolved path", async () => {
    const base = await serve();
    for (const path of ["/site/../echo/1", "/site/%2e%2e/echo/1", "/site/.%2E/echo/1", "/./echo/1", "/echo/1/.", "/site/x\\..\\..\\echo\\1"]) {
      expect(await rawGet(base, path), path).toBe(400);
    }
    expect(await rawGet(base, "/site/.well-known/x")).toBe(200);
    expect(await rawGet(base, "/echo/1?next=/../x")).toBe(200);
  });

  it("answers 400 to a member of the input schema sent in the query and keeps a body member and an unrelated query key working", async () => {
    const base = await serve();
    const post = (query: string, body: unknown) => fetch(`${base}/save${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const refused = await post("?role=admin", {});
    expect(refused.status).toBe(400);
    expect(await jsonBody<{ code: string }>(refused)).toMatchObject({ code: "VALIDATION" });
    expect((await post("?role=admin", { role: "viewer" })).status).toBe(400);
    const accepted = await post("?_=1", { role: "viewer" });
    expect(accepted.status).toBe(200);
    expect(await jsonBody<{ role: string }>(accepted)).toMatchObject({ role: "viewer" });
  });

  it("tells a wrapping handler which pipeline the request was routed to", async () => {
    kestrel = await boot({ config, modules: [store], pipelines, logger: silentLogger });
    const handler = createKestrelHandler(kestrel);
    const seen: Array<string | undefined> = [];
    const app = createApp();
    app.use(eventHandler(async (event) => {
      const answer: unknown = await handler(event);
      seen.push(routedPipeline(event));
      return answer;
    }));
    const server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    const base = `http://127.0.0.1:${boundaryCast<AddressInfo>(server.address(), "host").port}`;
    await fetch(`${base}/echo/1`);
    await fetch(`${base}/site/a/b/`);
    await fetch(`${base}/nope`);
    expect(seen).toEqual(["echo", "echo", undefined]);
  });

  it("routes params, query, json body, headers and ip like the core server", async () => {
    const base = await serve();
    const res = await fetch(`${base}/echo/42?x=1`, { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kestrel-run-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ payload: { x: "1" }, params: { id: "42" }, ip: "127.0.0.1", auth: "Bearer t" });
    const post = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    expect((await jsonBody<{ payload: unknown }>(post)).payload).toEqual({ a: 1 });
    expect((await jsonBody<{ params: unknown }>(await fetch(`${base}/site/en/about`))).params).toEqual({ path: "en/about" });
  });

  it("derives the client ip with the core policy: trusted header, then X-Forwarded-For from the right, then the peer", async () => {
    const ipVia = async (options: Parameters<typeof createKestrelHandler>[1], headers: Record<string, string>) => {
      await close?.();
      await kestrel?.stop();
      const base = await serve(options);
      return (await jsonBody<{ ip: string | null }>(await fetch(`${base}/echo/1`, { headers }))).ip;
    };
    expect(await ipVia({}, { "x-forwarded-for": "203.0.113.9" })).toBe("127.0.0.1");
    expect(await ipVia({ trustProxy: true }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("10.0.0.1");
    expect(await ipVia({ trustProxy: true, proxyHops: 2 }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
    expect(await ipVia({ trustProxy: true, proxyHops: 3 }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBeNull();
    expect(await ipVia({ trustProxy: true }, {})).toBeNull();
    expect(await ipVia({ trustedHeader: "Trusted-Client-IP", trustProxy: true }, { "trusted-client-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" })).toBe("198.51.100.7");
    expect(await ipVia({ trustedHeader: "Trusted-Client-IP" }, { "x-forwarded-for": "203.0.113.9" })).toBeNull();
  });

  it("reads forwarding headers only from a peer in trustedProxies, otherwise the peer is the client", async () => {
    const ipsVia = async (options: Parameters<typeof createKestrelHandler>[1], values: string[]) => {
      await close?.();
      await kestrel?.stop();
      const base = await serve(options);
      const ips: Array<string | null> = [];
      for (const value of values) ips.push((await jsonBody<{ ip: string | null }>(await fetch(`${base}/echo/1`, { headers: { "x-real-ip": value, "x-forwarded-for": value } }))).ip);
      return ips;
    };
    const rotating = ["10.9.9.1", "10.9.9.2", "10.9.9.3"];
    expect(await ipsVia({ trustedHeader: "X-Real-IP", trustedProxies: ["192.0.2.1"] }, rotating)).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1"]);
    expect(await ipsVia({ trustProxy: true, trustedProxies: ["192.0.2.1"] }, rotating)).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1"]);
    expect(await ipsVia({ trustedHeader: "X-Real-IP", trustedProxies: ["127.0.0.1"] }, rotating)).toEqual(rotating);
    expect(await ipsVia({ trustedHeader: "X-Real-IP" }, rotating)).toEqual(rotating);
  });

  it("groups repeated query keys into arrays, keeps single values as strings", async () => {
    const base = await serve();
    const res = await fetch(`${base}/echo/1?tag=a&tag=b`);
    expect((await jsonBody<{ payload: unknown }>(res)).payload).toEqual({ tag: ["a", "b"] });
    const single = await fetch(`${base}/echo/1?tag=a`);
    expect((await jsonBody<{ payload: unknown }>(single)).payload).toEqual({ tag: "a" });
  });

  it("maps failures, unknown routes and bad bodies to the same error format", async () => {
    const base = await serve();
    const fail = await fetch(`${base}/fail`);
    expect(fail.status).toBe(418);
    expect(await fail.json()).toMatchObject({ error: "teapot", code: "TEAPOT", retryable: false, runId: expect.any(String) as unknown });
    const notFound = await fetch(`${base}/nope`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
    const bad = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION", retryable: false });
    const big = await serve({ maxBodyBytes: 16 });
    const tooLarge = await fetch(`${big}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(100) }) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
  });

  it("answers 415 to a body that is not declared as JSON", async () => {
    const base = await serve();
    const plain = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ a: 1 }) });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toMatchObject({ code: "UNSUPPORTED", retryable: false });
  });

  it("sends the response headers a pipeline sets", async () => {
    const base = await serve();
    const res = await fetch(`${base}/greet`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(["greeting=hello; HttpOnly; Path=/", "visit=1; HttpOnly; Path=/"]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("handles multipart uploads and binary downloads", async () => {
    const base = await serve();
    const form = new FormData();
    form.set("note", "hi");
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "pic.png");
    const up = await fetch(`${base}/files`, { method: "POST", body: form });
    expect(await up.json()).toEqual({ filename: "pic.png", size: 3 });
    const down = await fetch(`${base}/files/pic.png`);
    expect(down.headers.get("content-type")).toBe("image/png");
    expect(down.headers.get("content-disposition")).toBe('inline; filename="pic.png"');
    expect(Array.from(new Uint8Array(await down.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("honours a mount path", async () => {
    const base = await serve({ mountPath: "/api" });
    expect((await fetch(`${base}/api/echo/1`)).status).toBe(200);
    expect((await fetch(`${base}/echo/1`)).status).toBe(404);
  });

  it("echoes an incoming x-request-id on run responses and on router-level errors", async () => {
    const base = await serve();
    const headers = { "x-request-id": "req-42" };
    const ok = await fetch(`${base}/echo/1`, { headers });
    expect(ok.headers.get("x-request-id")).toBe("req-42");
    const fail = await fetch(`${base}/fail`, { headers });
    expect(fail.headers.get("x-request-id")).toBe("req-42");
    const missing = await fetch(`${base}/nope`, { headers });
    expect(missing.headers.get("x-request-id")).toBe("req-42");
    expect((await fetch(`${base}/echo/1`)).headers.get("x-request-id")).toBeNull();
  });

  it("reports the failing step and the details a step attached", async () => {
    const base = await serve();
    const body = await jsonBody<{ error: string; code?: string; retryable?: boolean; step?: string; details?: unknown }>(await fetch(`${base}/fail`));
    expect(body.error).toBe("teapot");
    expect(body.code).toBe("TEAPOT");
    expect(body.retryable).toBe(false);
    expect(body.step).toBe("store.fail");
    expect(body.details).toEqual({ pot: true });
  });

  it("omits Retry-After on a non-retryable failure", async () => {
    const base = await serve();
    expect((await fetch(`${base}/fail`)).headers.get("retry-after")).toBeNull();
  });

  it("carries a run id on router-level errors", async () => {
    const base = await serve();
    const big = await serve({ maxBodyBytes: 10 });
    const cases = [
      await fetch(`${base}/nope`),
      await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" }),
      await fetch(`${big}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(100) }) }),
    ];
    for (const res of cases) {
      const runId = res.headers.get("x-kestrel-run-id");
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await jsonBody<{ runId?: string }>(res)).runId).toBe(runId);
    }
  });
});
