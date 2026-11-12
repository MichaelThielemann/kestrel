import { createServer, request, type ServerOptions } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { createApp, toNodeListener } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, ok, silentLogger, type Context, type Kestrel, type Logger } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createKestrelHandler, type KestrelHandlerOptions, type KestrelRunner } from "./index.ts";

interface Line {
  message: string;
  [field: string]: unknown;
}

function collectingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const push = (message: string, data: Record<string, unknown> = {}) => lines.push({ message, ...data });
  return { lines, logger: { step() {}, info: push, warn: push, error: push } };
}

const notes = defineModule({
  name: "notes/memory",
  provides: [],
  requires: [],
  configSchema: z.object({}),
  async setup() {
    return {};
  },
  steps: () => ({
    echo: async (ctx: Context) => ok({ ...ctx, result: { payload: ctx.payload } }),
    deny: async (ctx: Context) => ctx.fail("FORBIDDEN", "not yours"),
  }),
  describe: () => ({
    echo: { summary: "Echoes the payload.", reads: ["payload"], writes: ["result"], output: { type: "object" } },
    deny: { summary: "Always refuses.", reads: [], writes: [] },
  }),
});

const config = {
  modules: [{ use: "./notes", config: {} }],
  triggers: [
    { http: "GET /notes/:id", pipeline: "echo" },
    { http: "POST /notes", pipeline: "echo" },
    { http: "GET /locked", pipeline: "deny" },
  ],
  http: null,
};
const pipelines = [definePipeline({ name: "echo", steps: ["notes.echo"] }), definePipeline({ name: "deny", steps: ["notes.deny"] })];

let kestrel: Kestrel | undefined;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  await kestrel?.stop();
  kestrel = undefined;
});

const duration = { asymmetricMatch: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0, toString: () => "a duration in ms" };

let hostErrors: unknown[] = [];

async function listen(runner: KestrelRunner, options: KestrelHandlerOptions, serverOptions: ServerOptions = {}): Promise<string> {
  hostErrors = [];
  const app = createApp({ onError: (error, event) => { hostErrors.push(error); event.node.res.end(); } });
  app.use(createKestrelHandler(runner, options));
  const server = createServer(serverOptions, toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return `http://127.0.0.1:${boundaryCast<AddressInfo>(server.address(), "host").port}`;
}

async function serve(options: KestrelHandlerOptions = {}, serverOptions: ServerOptions = {}): Promise<string> {
  kestrel = await boot({ config, modules: [notes], pipelines, logger: silentLogger });
  return listen(kestrel, options, serverOptions);
}

function partialPost(base: string, headers: string, abortAfterMs?: number): Promise<string> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    let received = "";
    const socket = connect(Number(port), hostname, () => {
      socket.write(`POST /notes HTTP/1.1\r\nHost: notes.test\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n${headers}\r\n{"text":`);
      if (abortAfterMs !== undefined) setTimeout(() => socket.destroy(), abortAfterMs);
    });
    socket.on("data", (chunk: Buffer) => { received += chunk.toString("latin1"); });
    socket.on("error", () => {});
    socket.on("close", () => resolve(received));
  });
}

function slowPost(base: string, pauseMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/notes`, { method: "POST", headers: { "content-type": "application/json", "content-length": "15" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.write('{"text":');
    setTimeout(() => req.end('"slow"}'), pauseMs);
  });
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

const json = { "content-type": "application/json" };

describe("kestrel-h3 request log", () => {
  it("writes one http line per routed request with the fields of the core server", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    const res = await fetch(`${base}/notes/7?x=1`, { headers: { "x-request-id": "req-1" } });
    expect(res.status).toBe(200);
    const denied = await fetch(`${base}/locked`);
    expect(denied.status).toBe(403);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ message: "http", runId: res.headers.get("x-kestrel-run-id"), requestId: "req-1", method: "GET", path: "/notes/7", pipeline: "echo", status: 200, ms: duration, ip: "127.0.0.1" });
    expect(lines[1]).toEqual({ message: "http", runId: denied.headers.get("x-kestrel-run-id"), method: "GET", path: "/locked", pipeline: "deny", status: 403, ms: duration, ip: "127.0.0.1" });
  });

  it("logs the full path under a mount path", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger, mountPath: "/api" });
    await fetch(`${base}/api/notes/1`);
    expect(lines).toEqual([expect.objectContaining({ path: "/api/notes/1", pipeline: "echo", status: 200 })]);
  });

  it("writes one line with a reason for every refusal before the pipeline", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger, maxBodyBytes: 64 });
    const refusals = [
      await fetch(`${base}/nowhere`),
      await fetch(`${base}/notes`, { method: "POST", headers: json, body: "{oops" }),
      await fetch(`${base}/notes`, { method: "POST", headers: json, body: JSON.stringify({ text: "x".repeat(200) }) }),
      await fetch(`${base}/notes`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" }),
    ];
    expect(refusals.map((r) => r.status)).toEqual([404, 400, 413, 415]);
    expect(lines).toHaveLength(4);
    const [notFound, invalid, tooLarge, unsupported] = lines;
    expect(notFound).toEqual({ message: "http", runId: refusals[0]?.headers.get("x-kestrel-run-id"), method: "GET", path: "/nowhere", status: 404, ms: duration, ip: "127.0.0.1", reason: "no route" });
    expect(invalid).toMatchObject({ runId: refusals[1]?.headers.get("x-kestrel-run-id"), method: "POST", path: "/notes", pipeline: "echo", status: 400, reason: "invalid body: malformed JSON" });
    expect(tooLarge).toMatchObject({ runId: refusals[2]?.headers.get("x-kestrel-run-id"), pipeline: "echo", status: 413, reason: "body exceeds 64 bytes", declaredBytes: 211 });
    expect(unsupported).toMatchObject({ runId: refusals[3]?.headers.get("x-kestrel-run-id"), pipeline: "echo", status: 415, reason: "unsupported content type" });
  });

  it("logs a path with a dot segment as a refusal without resolving it", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    expect(await rawGet(base, "/notes/../locked?next=1")).toBe(400);
    expect(lines).toEqual([expect.objectContaining({ method: "GET", path: "/notes/../locked", status: 400, reason: "invalid path: dot segment" })]);
    expect(lines[0]).not.toHaveProperty("pipeline");
  });

  it("logs a multipart body to a route that reads no files as a refusal", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    const form = new FormData();
    form.set("note", "hi");
    const res = await fetch(`${base}/notes`, { method: "POST", body: form });
    expect(res.status).toBe(415);
    expect(lines).toEqual([expect.objectContaining({ pipeline: "echo", status: 415, reason: "this route does not accept multipart/form-data" })]);
  });

  it("keeps bodies, cookies, header values and query strings out of the line", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger, maxBodyBytes: 512 });
    const secretHeaders = { authorization: "Bearer tok-secret-1", cookie: "session=cookie-secret-2", "x-api-key": "key-secret-3" };
    await fetch(`${base}/notes/1?token=query-secret-4`, { headers: secretHeaders });
    await fetch(`${base}/notes?token=query-secret-4`, { method: "POST", headers: { ...json, ...secretHeaders }, body: JSON.stringify({ password: "body-secret-5" }) });
    await fetch(`${base}/notes`, { method: "POST", headers: { ...json, ...secretHeaders }, body: '{"password": body-secret-6}' });
    await fetch(`${base}/notes`, { method: "POST", headers: { "content-type": "text/secret-type-7", ...secretHeaders }, body: "body-secret-8" });
    await fetch(`${base}/notes`, { method: "POST", headers: { ...json, ...secretHeaders }, body: JSON.stringify({ password: "body-secret-9".repeat(100) }) });
    await fetch(`${base}/nowhere?token=query-secret-4`, { headers: secretHeaders });
    expect(lines).toHaveLength(6);
    expect(lines[2]).toMatchObject({ status: 400, reason: "invalid body: malformed JSON" });
    const written = JSON.stringify(lines);
    for (const secret of ["tok-secret-1", "cookie-secret-2", "key-secret-3", "query-secret-4", "body-secret-5", "body-secret-6", "secret-type-7", "body-secret-8", "body-secret-9", "token="]) {
      expect(written).not.toContain(secret);
    }
  });

  it("logs the request id it echoes, and neither logs nor echoes an invalid one", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    const refused = await fetch(`${base}/nowhere`, { headers: { "x-request-id": "req-404" } });
    const invalid = await fetch(`${base}/notes/1`, { headers: { "x-request-id": "x".repeat(201) } });
    expect(refused.headers.get("x-request-id")).toBe("req-404");
    expect(invalid.headers.get("x-request-id")).toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ requestId: "req-404", status: 404, reason: "no route" });
    expect(lines[1]).not.toHaveProperty("requestId");
  });

  it("names a JSON body that is not an object in the reason", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    expect((await fetch(`${base}/notes`, { method: "POST", headers: json, body: "[1,2]" })).status).toBe(400);
    expect(lines).toEqual([expect.objectContaining({ status: 400, pipeline: "echo", reason: "invalid body: body must be a JSON object" })]);
  });

  it("writes a line with status 500 when the handler throws, and rethrows", async () => {
    const { logger, lines } = collectingLogger();
    kestrel = await boot({ config, modules: [notes], pipelines, logger: silentLogger });
    const failing: KestrelRunner = { triggers: kestrel.triggers, run: () => Promise.reject(new Error("store gone")) };
    const base = await listen(failing, { logger });
    const res = await fetch(`${base}/notes/1?token=query-secret`, { headers: { "x-request-id": "req-500" } });
    expect(res.status).toBe(500);
    expect(hostErrors).toEqual([expect.objectContaining({ message: "store gone" })]);
    expect(lines).toEqual([expect.objectContaining({ message: "http", requestId: "req-500", method: "GET", path: "/notes/1", pipeline: "echo", status: 500, reason: "handler failed" })]);
    expect(lines[0]?.runId).toEqual(res.headers.get("x-kestrel-run-id"));
    expect(res.headers.get("x-request-id")).toBe("req-500");
  });

  it("logs only the path of an absolute-form request target, without userinfo or host", async () => {
    const { logger, lines } = collectingLogger();
    kestrel = await boot({ config, modules: [notes], pipelines, logger: silentLogger });
    const failing: KestrelRunner = { triggers: kestrel.triggers, run: () => Promise.reject(new Error("store gone")) };
    const base = await listen(failing, { logger });
    const target = (path: string) => `http://alice:hunter2@notes.test${path}?token=query-secret`;
    expect(await rawGet(base, target("/notes/1"))).toBe(500);
    expect(await rawGet(base, target("/notes/../locked"))).toBe(400);
    expect(await rawGet(base, target("/nowhere"))).toBe(404);
    expect(lines.map((l) => [l.status, l.path])).toEqual([[500, "/notes/1"], [400, "/notes/../locked"], [404, "/nowhere"]]);
    const written = JSON.stringify(lines);
    for (const secret of ["alice", "hunter2", "notes.test", "query-secret"]) expect(written).not.toContain(secret);
  });

  it("counts the time spent reading the body in ms", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    expect(await slowPost(base, 200)).toBe(200);
    expect(lines).toEqual([expect.objectContaining({ pipeline: "echo", status: 200, ms: duration })]);
    expect(lines[0]?.ms).toBeGreaterThanOrEqual(150);
  });

  it("logs a body the client stops sending as a closed connection, as the core server does", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger });
    expect(await partialPost(base, "X-Request-Id: req-gone\r\n", 50)).toBe("");
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ message: "http", runId: expect.any(String) as unknown, requestId: "req-gone", method: "POST", path: "/notes", pipeline: "echo", status: 400, ms: duration, ip: "127.0.0.1", reason: "body not received: connection closed", declaredBytes: 1000 });
    expect(hostErrors).toEqual([]);
  });

  it("logs a body cut off by the server's request timeout as the 408 the client receives", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve({ logger }, { requestTimeout: 300, headersTimeout: 300, connectionsCheckingInterval: 50 });
    expect(await partialPost(base, "X-Request-Id: req-slow\r\n")).toMatch(/^HTTP\/1\.1 408 /);
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toMatchObject({ requestId: "req-slow", pipeline: "echo", status: 408, reason: "body not received: request timeout", declaredBytes: 1000 });
    expect(lines[0]?.ms).toBeGreaterThanOrEqual(300);
    expect(hostErrors).toEqual([]);
  });
});
