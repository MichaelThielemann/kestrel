import { afterEach, describe, it, expect } from "vitest";
import { binaryResult } from "../context.ts";
import { silentLogger } from "../logger.ts";
import type { RunResult, Runner } from "../runner.ts";
import { buildResponse, createHttpServer, disposition, errorResponse, listen, matchRoute, parseQuery, parseRoute, responseForRun, routePattern, type Route } from "./http.ts";

describe("http routes", () => {
  const routes = [parseRoute("GET /pages/:id", "readPage"), parseRoute("POST /pages", "createPage"), parseRoute("GET /", "home")];

  it("matches params", () => {
    const m = matchRoute(routes, "GET", "/pages/abc%20d");
    expect(m?.route.pipeline).toBe("readPage");
    expect(m?.params).toEqual({ id: "abc d" });
  });

  it("distinguishes methods and lengths", () => {
    expect(matchRoute(routes, "POST", "/pages")?.route.pipeline).toBe("createPage");
    expect(matchRoute(routes, "DELETE", "/pages")).toBeUndefined();
    expect(matchRoute(routes, "GET", "/pages/a/b")).toBeUndefined();
    expect(matchRoute(routes, "GET", "/")?.route.pipeline).toBe("home");
  });

  it("captures the rest of the path with a trailing wildcard", () => {
    const wild = [parseRoute("GET /site/*path", "resolve"), parseRoute("GET /site", "home")];
    expect(matchRoute(wild, "GET", "/site/en/about%20us")?.params).toEqual({ path: "en/about us" });
    expect(matchRoute(wild, "GET", "/site/")?.route.pipeline).toBe("home");
    expect(matchRoute([wild[0] as Route], "GET", "/site/")?.params).toEqual({ path: "" });
    expect(matchRoute(wild, "GET", "/other/x")).toBeUndefined();
    expect(() => parseRoute("GET /*path/more", "x")).toThrow(/wildcard must be the last segment/);
  });

  it("prefers the more specific route regardless of registration order", () => {
    const param = parseRoute("GET /media/:id", "getMedia");
    const literal = parseRoute("GET /media/folders", "listFolders");
    const wild = parseRoute("GET /media/*rest", "catchAll");
    for (const order of [[param, literal, wild], [wild, param, literal]]) {
      expect(matchRoute(order, "GET", "/media/folders")?.route.pipeline).toBe("listFolders");
      expect(matchRoute(order, "GET", "/media/abc")?.route.pipeline).toBe("getMedia");
      expect(matchRoute(order, "GET", "/media/a/b")?.route.pipeline).toBe("catchAll");
    }
  });

  it("treats routes differing only in a param name as the same pattern", () => {
    expect(routePattern(parseRoute("GET /a/:id", "x"))).toBe(routePattern(parseRoute("GET /a/:key", "y")));
    expect(routePattern(parseRoute("GET /a/*rest", "x"))).toBe("GET /a/*");
    expect(routePattern(parseRoute("POST /a/:id", "x"))).not.toBe(routePattern(parseRoute("GET /a/:id", "y")));
  });

  it("a malformed percent-escape does not match instead of throwing", () => {
    expect(matchRoute(routes, "GET", "/pages/%zz")).toBeUndefined();
    expect(matchRoute([parseRoute("GET /site/*path", "resolve")], "GET", "/site/%zz")).toBeUndefined();
  });

  it("an encoded separator in the wildcard tail does not match", () => {
    const wild = [parseRoute("GET /site/*path", "resolve")];
    expect(matchRoute(wild, "GET", "/site/a%2Fb")).toBeUndefined();
    expect(matchRoute(wild, "GET", "/site/a/b")?.params).toEqual({ path: "a/b" });
  });

  it("rejects malformed triggers", () => {
    expect(() => parseRoute("GET pages", "x")).toThrow(/invalid http trigger/);
    expect(() => parseRoute("GET //pages", "x")).toThrow(/empty path segment/);
  });

  it("serves only known-safe types inline, everything else as attachment", () => {
    expect(disposition("image/png", "a.png")).toBe('inline; filename="a.png"');
    expect(disposition("image/svg+xml", "a.svg")).toBe('attachment; filename="a.svg"');
    expect(disposition("text/html; charset=utf-8", "a.html")).toBe('attachment; filename="a.html"');
    expect(disposition("application/pdf", undefined)).toBe("attachment");
  });

  it("keeps a non-ASCII filename readable per RFC 6266", () => {
    expect(disposition("application/pdf", "mein bericht.pdf")).toBe('attachment; filename="mein bericht.pdf"');
    expect(disposition("application/pdf", 'a"b.pdf')).toBe('attachment; filename="a\\"b.pdf"');
    expect(disposition("application/pdf", "Bärenbericht.pdf")).toBe("attachment; filename=\"B_renbericht.pdf\"; filename*=UTF-8''B%C3%A4renbericht.pdf");
  });

  it("caller headers on a binary result may add but not weaken the mandatory ones", () => {
    const body = { ...binaryResult(new Uint8Array([1]), "image/png", "a.png"), headers: { "Cache-Control": "public, max-age=31536000", "x-content-type-options": "", "x-content-provenance": "human" } };
    const { headers } = buildResponse(200, body, { runId: "run-1" });
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-kestrel-run-id"]).toBe("run-1");
    expect(headers["x-content-provenance"]).toBe("human");
  });

  it("also serves configured extra content types inline", () => {
    expect(disposition("image/svg+xml", "a.svg", ["image/svg+xml"])).toBe('inline; filename="a.svg"');
    expect(disposition("image/svg+xml", "a.svg", [])).toBe('attachment; filename="a.svg"');
    expect(disposition("image/svg+xml; charset=utf-8", "a.svg", ["image/svg+xml"])).toBe('inline; filename="a.svg"');
  });

  it("groups repeated query keys into arrays, keeps single values as strings", () => {
    expect(parseQuery(new URLSearchParams("tag=a&tag=b"))).toEqual({ tag: ["a", "b"] });
    expect(parseQuery(new URLSearchParams("tag=a"))).toEqual({ tag: "a" });
    expect(parseQuery(new URLSearchParams("a=1&b=2"))).toEqual({ a: "1", b: "2" });
  });
});

describe("http error format", () => {
  const failed: RunResult = { runId: "run-1", status: 400, error: "pages: slug must be unique", code: "VALIDATION", retryable: false, step: "content.create", details: { fields: [{ field: "slug", message: "must be unique" }] } };

  it("puts code, retryable, step and details next to error and runId", () => {
    const res = responseForRun(failed);
    expect(JSON.parse(res.body as string)).toEqual({ error: "pages: slug must be unique", code: "VALIDATION", retryable: false, runId: "run-1", step: "content.create", details: { fields: [{ field: "slug", message: "must be unique" }] } });
  });

  it("omits step and details when the run carries none", () => {
    expect(JSON.parse(responseForRun({ runId: "run-2", status: 404, error: "not found", code: "NOT_FOUND", retryable: false }).body as string)).toEqual({ error: "not found", code: "NOT_FOUND", retryable: false, runId: "run-2" });
  });

  it("echoes the request id on both a run response and an edge error", () => {
    expect(responseForRun({ ...failed, requestId: "req-1" }).headers["x-request-id"]).toBe("req-1");
    const edge = errorResponse(404, "no route", "req-2");
    expect(edge.headers["x-request-id"]).toBe("req-2");
    expect(edge.headers["x-kestrel-run-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(errorResponse(404, "no route").headers["x-request-id"]).toBeUndefined();
  });

  it("assigns errorResponse a fixed code by status and retryable: false", () => {
    expect(JSON.parse(errorResponse(400, "bad body").body as string)).toMatchObject({ code: "VALIDATION", retryable: false });
    expect(JSON.parse(errorResponse(404, "no route").body as string)).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(JSON.parse(errorResponse(413, "too big").body as string)).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
    expect(JSON.parse(errorResponse(500, "internal error").body as string)).toMatchObject({ code: "INTERNAL", retryable: false });
  });

  it("sets Retry-After on a retryable 429 or 503, using details.retryAfterSeconds", () => {
    const rateLimited: RunResult = { runId: "run-3", status: 429, error: "too many requests", code: "RATE_LIMITED", retryable: true, details: { retryAfterSeconds: 30 } };
    expect(responseForRun(rateLimited).headers["retry-after"]).toBe("30");
    const transient: RunResult = { runId: "run-4", status: 503, error: "database is busy", code: "TRANSIENT", retryable: true };
    expect(responseForRun(transient).headers["retry-after"]).toBe("1");
  });

  it("falls back to the default Retry-After when details.retryAfterSeconds is not a positive integer", () => {
    const zero: RunResult = { runId: "run-5", status: 503, error: "busy", code: "TRANSIENT", retryable: true, details: { retryAfterSeconds: 0 } };
    expect(responseForRun(zero).headers["retry-after"]).toBe("1");
    const fractional: RunResult = { runId: "run-6", status: 503, error: "busy", code: "TRANSIENT", retryable: true, details: { retryAfterSeconds: 2.5 } };
    expect(responseForRun(fractional).headers["retry-after"]).toBe("1");
  });

  it("omits Retry-After when not retryable, even on 429/503, and on any other status", () => {
    expect(responseForRun({ runId: "run-7", status: 429, error: "x", code: "RATE_LIMITED", retryable: false }).headers["retry-after"]).toBeUndefined();
    expect(responseForRun(failed).headers["retry-after"]).toBeUndefined();
    const forbidden: RunResult = { runId: "run-8", status: 403, error: "no", code: "FORBIDDEN", retryable: true };
    expect(responseForRun(forbidden).headers["retry-after"]).toBeUndefined();
  });
});

describe("http server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(run: Runner, options: Parameters<typeof createHttpServer>[3] = {}): Promise<string> {
    const server = createHttpServer([parseRoute("GET /echo", "echo")], run, silentLogger, options);
    const address = await listen(server, 0, "127.0.0.1");
    close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    return `http://127.0.0.1:${address.port}`;
  }

  const ok: Runner = async () => ({ runId: "run-1", status: 200, result: { ok: true } });

  it("closes the server to addresses outside http.allow, trusting X-Forwarded-For only with trustProxy", async () => {
    let base = await serve(ok, { allow: ["127.0.0.1"] });
    expect((await fetch(`${base}/echo`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await close?.();

    base = await serve(ok, { allow: ["203.0.113.0/24"] });
    const denied = await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "203.0.113.9", "x-request-id": "req-7" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", code: "FORBIDDEN", retryable: false, runId: expect.any(String) as string });
    expect(denied.headers.get("x-request-id")).toBe("req-7");
    expect((await fetch(`${base}/health`)).status).toBe(403);
    await close?.();

    base = await serve(ok, { allow: ["203.0.113.0/24"], trustProxy: true });
    expect((await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" } })).status).toBe(200);
    expect((await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.1" } })).status).toBe(403);
    expect((await fetch(`${base}/echo`)).status).toBe(403);
    await close?.();

    base = await serve(ok, { allow: ["203.0.113.0/24"], trustProxy: true, proxyHops: 2 });
    expect((await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } })).status).toBe(200);
    expect((await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(403);
    await close?.();

    base = await serve(ok, { allow: ["203.0.113.0/24"], trustedHeader: "Trusted-Client-IP", trustProxy: true });
    expect((await fetch(`${base}/echo`, { headers: { "trusted-client-ip": "203.0.113.9" } })).status).toBe(200);
    expect((await fetch(`${base}/echo`, { headers: { "trusted-client-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.9" } })).status).toBe(403);
    expect((await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(403);
    await close?.();

    base = await serve(ok, { allow: ["::ffff:127.0.0.1"], corsOrigin: "https://example.org" });
    expect((await fetch(`${base}/echo`, { method: "OPTIONS" })).status).toBe(204);
    expect(() => createHttpServer([], ok, silentLogger, { allow: ["example.org"] })).toThrow(/invalid entry "example.org"/);
  });

  it("applies the configured server timeouts", async () => {
    const server = createHttpServer([], ok, silentLogger, { timeouts: { requestMs: 1234, headersMs: 567, keepAliveMs: 89 } });
    expect([server.requestTimeout, server.headersTimeout, server.keepAliveTimeout]).toEqual([1234, 567, 89]);
    const defaults = createHttpServer([], ok, silentLogger);
    expect([defaults.requestTimeout, defaults.headersTimeout, defaults.keepAliveTimeout]).toEqual([30_000, 10_000, 5_000]);
  });

  it("echoes an incoming x-request-id on a run response, an edge error and health", async () => {
    let seen: string | undefined;
    const base = await serve(async (_pipeline, input) => {
      seen = input.headers?.["x-request-id"];
      return { runId: "run-1", status: 200, ...(seen === undefined ? {} : { requestId: seen }), result: { ok: true } };
    });
    const res = await fetch(`${base}/echo`, { headers: { "x-request-id": "req-9" } });
    expect(seen).toBe("req-9");
    expect(res.headers.get("x-request-id")).toBe("req-9");
    expect((await fetch(`${base}/nope`, { headers: { "x-request-id": "req-9" } })).headers.get("x-request-id")).toBe("req-9");
    expect((await fetch(`${base}/health`, { headers: { "x-request-id": "req-9" } })).headers.get("x-request-id")).toBe("req-9");
    expect(res.headers.get("x-kestrel-run-id")).toBe("run-1");
  });

  it("does not echo a request id that is not short printable ASCII", async () => {
    const base = await serve(ok);
    const res = await fetch(`${base}/echo`, { headers: { "x-request-id": "a".repeat(300) } });
    expect(res.headers.get("x-request-id")).toBeNull();
  });
});
