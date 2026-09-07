import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, toNodeListener } from "h3";
import { afterEach, describe, it, expect } from "vitest";
import { z } from "zod";
import { binaryResult, boot, customFailure, defineContract, defineModule, definePipeline, ok, silentLogger, type Context, type Kestrel } from "@michaelthielemann/kestrel";
import { createKestrelHandler } from "./index.ts";

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
    fail: async (ctx: Context) => ctx.fail(customFailure("TEAPOT", 418, "teapot", { details: { pot: true } })),
    upload: async (ctx: Context) => {
      const file = ctx.files[0];
      if (!file) return ctx.fail("VALIDATION", "no file");
      await db.put(file.filename, { contentType: file.contentType, data: [...file.data], note: ctx.payload.note });
      return ok({ ...ctx, result: { filename: file.filename, size: file.data.byteLength } });
    },
    download: async (ctx: Context) => {
      const doc = (await db.get(ctx.params.name ?? "")) as { contentType: string; data: number[] } | null;
      if (!doc) return ctx.fail("NOT_FOUND", "no such file");
      return ok({ ...ctx, result: binaryResult(new Uint8Array(doc.data), doc.contentType, ctx.params.name) });
    },
  }),
  describe: () => ({
    echo: { summary: "Echoes payload, params, ip and the authorization header.", reads: ["payload", "params", "ip", "headers.authorization"], writes: ["result"] },
    fail: { summary: "Always fails with a teapot error.", reads: [], writes: [] },
    upload: { summary: "Stores an uploaded file.", reads: ["files", "payload.note"], writes: ["result"] },
    download: { summary: "Serves a stored file as a binary result.", reads: ["params.name"], writes: ["result"] },
  }),
});

const config = {
  modules: [{ use: "./store", config: {} }],
  triggers: [
    { http: "GET /echo/:id", pipeline: "echo" },
    { http: "POST /echo", pipeline: "echo" },
    { http: "GET /fail", pipeline: "fail" },
    { http: "POST /files", pipeline: "upload" },
    { http: "GET /files/:name", pipeline: "download" },
    { http: "GET /site/*path", pipeline: "echo" },
  ],
  http: null,
};
const pipelines = [
  definePipeline({ name: "echo", steps: ["store.echo"] }),
  definePipeline({ name: "fail", steps: ["store.fail"] }),
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("kestrel-h3", () => {
  it("routes params, query, json body, headers and ip like the core server", async () => {
    const base = await serve();
    const res = await fetch(`${base}/echo/42?x=1`, { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kestrel-run-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ payload: { x: "1" }, params: { id: "42" }, ip: "127.0.0.1", auth: "Bearer t" });
    const post = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    expect(((await post.json()) as { payload: unknown }).payload).toEqual({ a: 1 });
    expect(((await (await fetch(`${base}/site/en/about`)).json()) as { params: unknown }).params).toEqual({ path: "en/about" });
  });

  it("groups repeated query keys into arrays, keeps single values as strings", async () => {
    const base = await serve();
    const res = await fetch(`${base}/echo/1?tag=a&tag=b`);
    expect(((await res.json()) as { payload: unknown }).payload).toEqual({ tag: ["a", "b"] });
    const single = await fetch(`${base}/echo/1?tag=a`);
    expect(((await single.json()) as { payload: unknown }).payload).toEqual({ tag: "a" });
  });

  it("maps failures, unknown routes and bad bodies to the same error format", async () => {
    const base = await serve();
    const fail = await fetch(`${base}/fail`);
    expect(fail.status).toBe(418);
    expect(await fail.json()).toMatchObject({ error: "teapot", code: "TEAPOT", retryable: false, runId: expect.any(String) as string });
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
    const body = (await (await fetch(`${base}/fail`)).json()) as { error: string; code?: string; retryable?: boolean; step?: string; details?: unknown };
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
      expect((await res.json() as { runId?: string }).runId).toBe(runId);
    }
  });
});
