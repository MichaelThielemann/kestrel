import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import type { Runner } from "../runner.ts";
import { createHttpServer, listen, parseRoute, type HttpOptions } from "./http.ts";

interface Line {
  message: string;
  [field: string]: unknown;
}

function collectingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const push = (message: string, data: Record<string, unknown> = {}) => lines.push({ message, ...data });
  return { lines, logger: { step() {}, info: push, warn: push, error: push } };
}

const routes = [parseRoute("GET /notes/:id", "readNote"), { ...parseRoute("POST /notes", "createNote"), files: false }];
const echo: Runner = async (_pipeline, input) => ({ runId: "run-1", status: 200, result: { ok: true }, ...(input.headers?.["x-request-id"] === undefined ? {} : { requestId: input.headers["x-request-id"] }) });
const json = { "content-type": "application/json" };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const duration = { asymmetricMatch: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0, toString: () => "a duration in ms" };

async function serve(logger: Logger, run: Runner = echo, options: HttpOptions = {}, checkEveryMs?: number): Promise<string> {
  const server = createHttpServer(routes, run, logger, options);
  if (checkEveryMs !== undefined) Object.assign(server, { connectionsCheckingInterval: checkEveryMs });
  const address = await listen(server, 0, "127.0.0.1");
  close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return `http://127.0.0.1:${address.port}`;
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

function rawRequest(base: string, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/`, { method, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
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

describe("http server request log", () => {
  it("writes one http line per routed request", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger);
    const res = await fetch(`${base}/notes/7?x=1`, { headers: { "x-request-id": "req-1" } });
    expect(res.status).toBe(200);
    expect(lines).toEqual([{ message: "http", runId: "run-1", requestId: "req-1", method: "GET", path: "/notes/7", pipeline: "readNote", status: 200, ms: duration, ip: "127.0.0.1" }]);
  });

  it("writes one line with a reason for every refusal before the pipeline", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger, echo, { maxBodyBytes: 64 });
    const form = new FormData();
    form.set("note", "hi");
    const refusals = [
      await fetch(`${base}/nowhere`, { headers: { "x-request-id": "req-404" } }),
      await fetch(`${base}/notes`, { method: "POST", headers: json, body: "{oops" }),
      await fetch(`${base}/notes`, { method: "POST", headers: json, body: "[1,2]" }),
      await fetch(`${base}/notes`, { method: "POST", headers: json, body: JSON.stringify({ text: "x".repeat(200) }) }),
      await fetch(`${base}/notes`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" }),
      await fetch(`${base}/notes`, { method: "POST", body: form }),
    ];
    expect(refusals.map((r) => r.status)).toEqual([404, 400, 400, 413, 415, 415]);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toEqual({ message: "http", runId: refusals[0]?.headers.get("x-kestrel-run-id"), requestId: "req-404", method: "GET", path: "/nowhere", status: 404, ms: duration, ip: "127.0.0.1", reason: "no route" });
    expect(refusals[0]?.headers.get("x-request-id")).toBe("req-404");
    expect(lines[1]).toMatchObject({ runId: refusals[1]?.headers.get("x-kestrel-run-id"), method: "POST", path: "/notes", pipeline: "createNote", status: 400, reason: "invalid body: malformed JSON" });
    expect(lines[2]).toMatchObject({ pipeline: "createNote", status: 400, reason: "invalid body: body must be a JSON object" });
    expect(lines[3]).toMatchObject({ runId: refusals[3]?.headers.get("x-kestrel-run-id"), pipeline: "createNote", status: 413, reason: "body exceeds 64 bytes", declaredBytes: 211 });
    expect(lines[4]).toMatchObject({ pipeline: "createNote", status: 415, reason: "unsupported content type" });
    expect(lines[5]).toMatchObject({ pipeline: "createNote", status: 415, reason: "this route does not accept multipart/form-data" });
  });

  it("logs a path with a dot segment as a refusal without resolving it", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger);
    expect(await rawGet(base, "/notes/../notes/1?next=1")).toBe(400);
    expect(lines).toEqual([expect.objectContaining({ method: "GET", path: "/notes/../notes/1", status: 400, reason: "invalid path: dot segment" })]);
    expect(lines[0]).not.toHaveProperty("pipeline");
  });

  it("logs a client refused by http.allow", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger, echo, { allow: ["203.0.113.0/24"] });
    const res = await fetch(`${base}/notes/1?token=query-secret`);
    expect(res.status).toBe(403);
    expect(lines).toEqual([{ message: "http", runId: res.headers.get("x-kestrel-run-id"), method: "GET", path: "/notes/1", status: 403, ms: duration, ip: "127.0.0.1", reason: "client not allowed" }]);
  });

  it("writes no line for the health path", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(lines).toEqual([]);
  });

  it("writes one line with status 500 when the runner throws, with the run id of the response", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger, () => Promise.reject(new Error("store gone")));
    const res = await fetch(`${base}/notes/1`, { headers: { "x-request-id": "req-500" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe("req-500");
    const http = lines.filter((l) => l.message === "http");
    expect(http).toEqual([expect.objectContaining({ runId: res.headers.get("x-kestrel-run-id"), requestId: "req-500", method: "GET", path: "/notes/1", pipeline: "readNote", status: 500, reason: "handler failed" })]);
  });

  it("keeps bodies, cookies, header values and query strings out of the line", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger, echo, { maxBodyBytes: 512 });
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

  it("counts the time spent reading the body in ms", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger);
    expect(await slowPost(base, 200)).toBe(200);
    expect(lines).toEqual([expect.objectContaining({ pipeline: "createNote", status: 200, ms: duration })]);
    expect(lines[0]?.ms).toBeGreaterThanOrEqual(150);
  });

  it("logs a body the client stops sending as a closed connection", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger);
    expect(await partialPost(base, "X-Request-Id: req-gone\r\n", 50)).toBe("");
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toEqual({ message: "http", runId: expect.any(String) as unknown, requestId: "req-gone", method: "POST", path: "/notes", pipeline: "createNote", status: 400, ms: duration, ip: "127.0.0.1", reason: "body not received: connection closed", declaredBytes: 1000 });
  });

  it("logs a body cut off by the request timeout as the 408 the client receives", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger, echo, { timeouts: { requestMs: 300, headersMs: 300 } }, 50);
    expect(await partialPost(base, "X-Request-Id: req-slow\r\n")).toMatch(/^HTTP\/1\.1 408 /);
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toMatchObject({ requestId: "req-slow", pipeline: "createNote", status: 408, reason: "body not received: request timeout", declaredBytes: 1000 });
    expect(lines[0]?.ms).toBeGreaterThanOrEqual(300);
  });

  it("logs only the path of an absolute-form request target, without userinfo or host", async () => {
    const target = (path: string) => `http://alice:hunter2@notes.test${path}?token=query-secret`;
    const allowed = collectingLogger();
    const base = await serve(allowed.logger, echo, { allow: ["203.0.113.0/24"] });
    expect(await rawRequest(base, "GET", target("/notes/1"))).toBe(403);
    await close?.();
    const failing = collectingLogger();
    const failingBase = await serve(failing.logger, () => Promise.reject(new Error("store gone")), { corsOrigin: "https://admin.example" });
    expect(await rawRequest(failingBase, "GET", target("/notes/1"))).toBe(500);
    expect(await rawRequest(failingBase, "GET", target("/notes/../notes/1"))).toBe(400);
    expect(await rawRequest(failingBase, "OPTIONS", target("/notes"))).toBe(204);
    expect(await rawRequest(failingBase, "GET", "http://alice:hunter2@notes.test")).toBe(404);
    const lines = [...allowed.lines, ...failing.lines.filter((l) => l.message === "http")];
    expect(lines.map((l) => [l.status, l.path])).toEqual([[403, "/notes/1"], [500, "/notes/1"], [400, "/notes/../notes/1"], [204, "/notes"], [404, "/"]]);
    const written = JSON.stringify(lines);
    for (const secret of ["alice", "hunter2", "notes.test", "query-secret"]) expect(written).not.toContain(secret);
  });

  it("logs a CORS preflight and lets a browser send and read the correlation headers", async () => {
    const { logger, lines } = collectingLogger();
    const base = await serve(logger, echo, { corsOrigin: "https://admin.example" });
    const preflight = await fetch(`${base}/notes?token=query-secret`, { method: "OPTIONS", headers: { origin: "https://admin.example", "access-control-request-headers": "x-request-id" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")?.split(/,\s*/)).toContain("x-request-id");
    const res = await fetch(`${base}/notes/1`, { headers: { origin: "https://admin.example", "x-request-id": "req-cors" } });
    expect(res.headers.get("access-control-expose-headers")?.split(/,\s*/)).toEqual(expect.arrayContaining(["x-kestrel-run-id", "x-request-id"]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ message: "http", runId: preflight.headers.get("x-kestrel-run-id"), method: "OPTIONS", path: "/notes", status: 204, ms: duration, ip: "127.0.0.1", reason: "cors preflight" });
    expect(lines[1]).toMatchObject({ requestId: "req-cors", pipeline: "readNote", status: 200 });
  });
});
