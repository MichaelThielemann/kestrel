import { request } from "node:http";
import { afterEach, describe, it, expect } from "vitest";
import { binaryResult } from "../context.ts";
import { silentLogger } from "../logger.ts";
import type { RunResult, Runner } from "../runner.ts";
import { BodyTooLarge, buildResponse, clientIpResolver, forwardingWarner, createHttpServer, disposition, errorResponse, hasDotSegment, listen, matchRoute, parseQuery, parseRequestBody, parseRoute, readRequestBody, responseForRun, routePattern, UnsupportedMediaType } from "./http.ts";

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
    expect(matchRoute(wild.slice(0, 1), "GET", "/site/")?.params).toEqual({ path: "" });
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

  it("recognizes literal and encoded dot segments, not dots inside a segment or in the query", () => {
    for (const path of ["/a/../b", "/a/%2e%2e/b", "/a/.%2E/b", "/./a", "/a/.", "/a\\..\\b", "/a/%2E"]) expect(hasDotSegment(path), path).toBe(true);
    for (const path of ["/a/b", "/.well-known/x", "/a/...", "/a/b.c", "/a?x=/../b", "/a#/../b", "/"]) expect(hasDotSegment(path), path).toBe(false);
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

  it("a binary result's own cache-control wins, but not the other mandatory headers", () => {
    const body = { ...binaryResult(new Uint8Array([1]), "image/png", "a.png"), headers: { "Cache-Control": "public, max-age=31536000", "x-content-type-options": "", "x-content-provenance": "human" } };
    const { headers } = buildResponse(200, body, { runId: "run-1" });
    expect(headers["cache-control"]).toBe("public, max-age=31536000");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-kestrel-run-id"]).toBe("run-1");
    expect(headers["x-content-provenance"]).toBe("human");
  });

  it("defaults a binary result with no cache-control of its own to no-store", () => {
    const body = binaryResult(new Uint8Array([1]), "image/png", "a.png");
    const { headers } = buildResponse(200, body);
    expect(headers["cache-control"]).toBe("no-store");
  });

  it("keeps no-store when a binary result sets an empty or blank cache-control", () => {
    for (const value of ["", "   "]) {
      const body = { ...binaryResult(new Uint8Array([1]), "image/png", "a.png"), headers: { "cache-control": value } };
      expect(buildResponse(200, body).headers["cache-control"]).toBe("no-store");
    }
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

describe("http request bodies", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("parses a JSON body only when it is declared as JSON", async () => {
    expect((await parseRequestBody("application/json", bytes('{"a":1}'))).payload).toEqual({ a: 1 });
    expect((await parseRequestBody("application/json; charset=utf-8", bytes('{"a":1}'))).payload).toEqual({ a: 1 });
    expect((await parseRequestBody("Application/JSON", bytes('{"a":1}'))).payload).toEqual({ a: 1 });
    expect((await parseRequestBody("application/merge-patch+json", bytes('{"a":1}'))).payload).toEqual({ a: 1 });
  });

  it("refuses a non-empty body of any other type as unsupported", async () => {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", ""]) {
      await expect(parseRequestBody(type, bytes('{"a":1}'))).rejects.toBeInstanceOf(UnsupportedMediaType);
    }
  });

  it("accepts an empty body whatever its declared type", async () => {
    expect((await parseRequestBody("text/plain", bytes(""))).payload).toEqual({});
    expect((await parseRequestBody("", bytes(""))).payload).toEqual({});
  });

  it("answers 415 with the UNSUPPORTED code for an edge error of that status", () => {
    expect(errorResponse(415, "unsupported").status).toBe(415);
    expect(JSON.parse(String(errorResponse(415, "unsupported").body))).toMatchObject({ code: "UNSUPPORTED", retryable: false });
  });
});

describe("http response headers from a run", () => {
  it("adds the headers a run carries, without overriding the mandatory ones", () => {
    const res = responseForRun({ runId: "run-1", status: 200, result: { ok: true }, headers: { "set-cookie": "a=b; HttpOnly", "cache-control": "public", "x-content-type-options": "none" } });
    expect(res.headers["set-cookie"]).toBe("a=b; HttpOnly");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("adds them to an error response as well", () => {
    const res = responseForRun({ runId: "run-2", status: 401, error: "no", code: "UNAUTHENTICATED", retryable: false, headers: { "set-cookie": "a=; Max-Age=0" } });
    expect(res.headers["set-cookie"]).toBe("a=; Max-Age=0");
  });
});

describe("http error format", () => {
  const failed: RunResult = { runId: "run-1", status: 400, error: "pages: slug must be unique", code: "VALIDATION", retryable: false, step: "content.create", details: { fields: [{ field: "slug", message: "must be unique" }] } };

  it("puts code, retryable, step and details next to error and runId", () => {
    const res = responseForRun(failed);
    expect(JSON.parse(String(res.body))).toEqual({ error: "pages: slug must be unique", code: "VALIDATION", retryable: false, runId: "run-1", step: "content.create", details: { fields: [{ field: "slug", message: "must be unique" }] } });
  });

  it("omits step and details when the run carries none", () => {
    expect(JSON.parse(String(responseForRun({ runId: "run-2", status: 404, error: "not found", code: "NOT_FOUND", retryable: false }).body))).toEqual({ error: "not found", code: "NOT_FOUND", retryable: false, runId: "run-2" });
  });

  it("echoes the request id on both a run response and an edge error", () => {
    expect(responseForRun({ ...failed, requestId: "req-1" }).headers["x-request-id"]).toBe("req-1");
    const edge = errorResponse(404, "no route", "req-2");
    expect(edge.headers["x-request-id"]).toBe("req-2");
    expect(edge.headers["x-kestrel-run-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(errorResponse(404, "no route").headers["x-request-id"]).toBeUndefined();
  });

  it("assigns errorResponse a fixed code by status and retryable: false", () => {
    expect(JSON.parse(String(errorResponse(400, "bad body").body))).toMatchObject({ code: "VALIDATION", retryable: false });
    expect(JSON.parse(String(errorResponse(404, "no route").body))).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(JSON.parse(String(errorResponse(413, "too big").body))).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
    expect(JSON.parse(String(errorResponse(500, "internal error").body))).toMatchObject({ code: "INTERNAL", retryable: false });
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

describe("request body reading", () => {
  function source(chunks: number, size: number): { stream: AsyncIterable<Uint8Array>; pulled: () => number } {
    let pulled = 0;
    async function* generate() {
      for (let i = 0; i < chunks; i++) {
        pulled += size;
        yield new Uint8Array(size);
      }
    }
    return { stream: generate(), pulled: () => pulled };
  }

  it("stops pulling chunks once the body exceeds the limit", async () => {
    const body = source(1000, 1024);
    await expect(readRequestBody(body.stream, 10 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(body.pulled()).toBeLessThanOrEqual(10 * 1024 + 1024);
  });

  it("refuses a declared Content-Length over the limit before pulling anything", async () => {
    const body = source(1, 16);
    await expect(readRequestBody(body.stream, 10, "11")).rejects.toThrow(/body exceeds 10 bytes/);
    expect(body.pulled()).toBe(0);
  });

  it("returns a body of exactly the limit", async () => {
    const body = source(10, 1024);
    expect((await readRequestBody(body.stream, 10 * 1024, "10240")).byteLength).toBe(10 * 1024);
  });
});

describe("multipart parsing", () => {
  function multipart(files: number, fields: number): { contentType: string; body: Uint8Array } {
    const boundary = "test-boundary";
    let text = "";
    for (let i = 0; i < files; i++) text += `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="f${i}.txt"\r\ncontent-type: text/plain\r\n\r\nf${i}\r\n`;
    for (let i = 0; i < fields; i++) text += `--${boundary}\r\ncontent-disposition: form-data; name="field${i}"\r\n\r\nv${i}\r\n`;
    return { contentType: `multipart/form-data; boundary="${boundary}"`, body: new TextEncoder().encode(`${text}--${boundary}--\r\n`) };
  }

  it("takes 20 files and 100 fields by default and refuses one more of either", async () => {
    const within = multipart(20, 100);
    const parsed = await parseRequestBody(within.contentType, within.body);
    expect([parsed.files.length, Object.keys(parsed.payload).length]).toEqual([20, 100]);
    const files = multipart(21, 0);
    await expect(parseRequestBody(files.contentType, files.body)).rejects.toThrow(/more than 20 files/);
    const fields = multipart(0, 101);
    await expect(parseRequestBody(fields.contentType, fields.body)).rejects.toThrow(/more than 100 fields/);
  });

  function manyParts(boundary: string, parts: number): Uint8Array {
    const part = `--${boundary}\r\ncontent-disposition: form-data; name="f"; filename="f.txt"\r\n\r\n\r\n`;
    return new TextEncoder().encode(`${part.repeat(parts)}--${boundary}--\r\n`);
  }

  it("counts parts against the boundary the parser uses, whatever other parameters say", async () => {
    const body = manyParts("x", 20_000);
    for (const contentType of [
      'multipart/form-data; a="; boundary=q"; boundary=x',
      'multipart/form-data; foo="a;boundary=zzz"; boundary=x',
      "multipart/form-data; BOUNDARY=x",
      'multipart/form-data; boundary="x"',
    ]) {
      const started = performance.now();
      await expect(parseRequestBody(contentType, body), contentType).rejects.toThrow(/more than 20 files/);
      expect(performance.now() - started, contentType).toBeLessThan(50);
    }
  });

  it("refuses a Content-Type with a duplicate, malformed or missing boundary before reading any part", async () => {
    const body = manyParts("x", 20_000);
    for (const contentType of [
      "multipart/form-data; boundary=x, boundary=zzz",
      "multipart/form-data; boundary=zzz; boundary=x",
      "multipart/form-data; boundary=x; Boundary=x",
      'multipart/form-data; a="unterminated; boundary=x',
      "multipart/form-data; boundary*=x",
      "multipart/form-data",
      "multipart/form-data; boundary=",
    ]) {
      const started = performance.now();
      await expect(parseRequestBody(contentType, body), contentType).rejects.toThrow(/invalid multipart/);
      expect(performance.now() - started, contentType).toBeLessThan(50);
    }
  });

  it("refuses a body that never reaches its closing delimiter or holds no part", async () => {
    const contentType = "multipart/form-data; boundary=x";
    const open = new TextEncoder().encode('--x\r\ncontent-disposition: form-data; name="a"\r\n\r\nv\r\n');
    await expect(parseRequestBody(contentType, open)).rejects.toThrow(/invalid multipart/);
    await expect(parseRequestBody(contentType, new TextEncoder().encode("no delimiter at all"))).rejects.toThrow(/invalid multipart/);
    const bareLf = new TextEncoder().encode('--x\ncontent-disposition: form-data; name="a"\n\nv\n--x--\n');
    await expect(parseRequestBody(contentType, bareLf)).rejects.toThrow(/invalid multipart/);
  });

  it("decodes fields, files, quoted names and UTF-8 filenames", async () => {
    const boundary = "----b";
    const text = [
      `--${boundary}\r\ncontent-disposition: form-data; name="note"\r\n\r\nhällo\r\nline two\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Übersicht %221%22.png"\r\nContent-Type: image/PNG\r\n\r\n\u0000\u0001\r\n`,
      `--${boundary}\r\ncontent-disposition: form-data; name="empty"; filename=""\r\n\r\n\r\n`,
      `--${boundary}--\r\nepilogue`,
    ].join("");
    const parsed = await parseRequestBody(`multipart/form-data; boundary=${boundary}`, new TextEncoder().encode(`preamble\r\n${text}`));
    expect(parsed.payload).toEqual({ note: "hällo\r\nline two" });
    expect(parsed.files.map((f) => [f.field, f.filename, f.contentType, [...f.data]])).toEqual([
      ["file", 'Übersicht "1".png', "image/png", [0, 1]],
      ["empty", "", "application/octet-stream", []],
    ]);
  });

  it("refuses a body of many empty parts without decoding them", async () => {
    const many = multipart(0, 50_000);
    const started = performance.now();
    await expect(parseRequestBody(many.contentType, many.body, { maxParts: 10, maxFiles: 10, maxFields: 10 })).rejects.toBeInstanceOf(BodyTooLarge);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("client address behind proxies", () => {
  const request = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });

  it("ignores forwarding headers from a peer outside trustedProxies and uses the peer address", () => {
    const resolve = clientIpResolver({ trustedHeader: "X-Real-IP", trustedProxies: ["10.0.0.1"] });
    expect(resolve(request("203.0.113.5", { "x-real-ip": "10.9.9.9" }))).toEqual({ ip: "203.0.113.5", missingHeader: false, forwardingIgnored: true });
    expect(resolve(request("203.0.113.5"))).toEqual({ ip: "203.0.113.5", missingHeader: false });
    const chain = clientIpResolver({ trustProxy: true, trustedProxies: ["10.0.0.1"] });
    expect(chain(request("203.0.113.5", { "x-forwarded-for": "10.9.9.9" }))).toEqual({ ip: "203.0.113.5", missingHeader: false, forwardingIgnored: true });
    expect(clientIpResolver({ trustedProxies: ["10.0.0.1"] })(request("203.0.113.5", { "x-forwarded-for": "10.9.9.9" }))).toEqual({ ip: "203.0.113.5", missingHeader: false });
  });

  it("warns once per peer and interval about ignored forwarding headers, for a bounded number of peers", () => {
    const lines: string[] = [];
    let now = 0;
    const warn = forwardingWarner((line) => lines.push(line), { intervalMs: 1000, maxPeers: 2, now: () => now });
    warn("203.0.113.5");
    warn("203.0.113.5");
    warn("203.0.113.6");
    expect(lines).toEqual([expect.stringContaining("203.0.113.5"), expect.stringContaining("203.0.113.6")]);
    expect(lines[0]).toMatch(/not in trustedProxies/);
    now = 1500;
    warn("203.0.113.5");
    expect(lines).toHaveLength(3);
    warn("203.0.113.7");
    warn("203.0.113.8");
    expect(lines).toHaveLength(5);
  });

  it("reads the forwarding headers of a peer inside trustedProxies", () => {
    const resolve = clientIpResolver({ trustedHeader: "X-Real-IP", trustedProxies: ["10.0.0.0/8"] });
    expect(resolve(request("10.0.0.1", { "x-real-ip": "198.51.100.7" }))).toEqual({ ip: "198.51.100.7", missingHeader: false });
    expect(resolve(request("::ffff:10.0.0.1", { "x-real-ip": "198.51.100.7" })).ip).toBe("198.51.100.7");
    const chain = clientIpResolver({ trustProxy: true, trustedProxies: ["10.0.0.0/8"] });
    expect(chain(request("10.0.0.1", { "x-forwarded-for": "203.0.113.9, 198.51.100.7" })).ip).toBe("198.51.100.7");
  });

  it("trusts loopback peers by default and treats a peer without an address as loopback", () => {
    const resolve = clientIpResolver({ trustedHeader: "X-Real-IP" });
    expect(resolve(request("127.0.0.1", { "x-real-ip": "198.51.100.7" })).ip).toBe("198.51.100.7");
    expect(resolve(request("::1", { "x-real-ip": "198.51.100.7" })).ip).toBe("198.51.100.7");
    expect(resolve(request(undefined, { "x-real-ip": "198.51.100.7" })).ip).toBe("198.51.100.7");
    expect(resolve(request("192.0.2.1", { "x-real-ip": "198.51.100.7" })).ip).toBe("192.0.2.1");
    expect(clientIpResolver({ trustedHeader: "X-Real-IP", trustedProxies: [] })(request(undefined, { "x-real-ip": "198.51.100.7" }))).toEqual({ missingHeader: false, forwardingIgnored: true });
  });

  it("takes the value the trusted peer appended last when the trusted header carries several", () => {
    const resolve = clientIpResolver({ trustedHeader: "X-Forwarded-For" });
    expect(resolve(request("127.0.0.1", { "x-forwarded-for": "10.9.9.9, 203.0.113.77" })).ip).toBe("203.0.113.77");
  });

  it("flags a trusted peer that sent no trusted header", () => {
    const resolve = clientIpResolver({ trustedHeader: "X-Real-IP" });
    expect(resolve(request("127.0.0.1"))).toEqual({ missingHeader: true });
    expect(resolve(request("192.0.2.1"))).toEqual({ ip: "192.0.2.1", missingHeader: false });
  });

  it("rejects a trustedProxies entry that is neither an address nor a CIDR range", () => {
    expect(() => clientIpResolver({ trustedProxies: ["proxy.example.org"] })).toThrow(/invalid entry "proxy.example.org"/);
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
    expect(await denied.json()).toEqual({ error: "forbidden", code: "FORBIDDEN", retryable: false, runId: expect.any(String) as unknown });
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

  it("decides http.allow on the peer address when the peer is not a trusted proxy", async () => {
    let base = await serve(ok, { allow: ["10.0.0.0/8"], trustedHeader: "X-Real-IP", trustedProxies: ["192.0.2.1"] });
    expect((await fetch(`${base}/echo`, { headers: { "x-real-ip": "10.9.9.9" } })).status).toBe(403);
    await close?.();
    base = await serve(ok, { allow: ["10.0.0.0/8"], trustProxy: true, trustedProxies: ["192.0.2.1"] });
    expect((await fetch(`${base}/echo`, { headers: { "x-forwarded-for": "10.9.9.9" } })).status).toBe(403);
    await close?.();
    base = await serve(ok, { allow: ["10.0.0.0/8"], trustedHeader: "X-Real-IP" });
    expect((await fetch(`${base}/echo`, { headers: { "x-real-ip": "10.9.9.9" } })).status).toBe(200);
  });

  it("refuses a request from a trusted proxy without the trusted header, with or without http.allow", async () => {
    let seen = 0;
    const counting: Runner = async () => {
      seen += 1;
      return { runId: "run-1", status: 200, result: { ok: true } };
    };
    let base = await serve(counting, { trustedHeader: "X-Real-IP" });
    const refused = await fetch(`${base}/echo`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "forbidden", code: "FORBIDDEN" });
    expect((await fetch(`${base}/echo`, { headers: { "x-real-ip": "198.51.100.7" } })).status).toBe(200);
    expect(seen).toBe(1);
    await close?.();
    base = await serve(counting, { trustedHeader: "X-Real-IP", allow: ["0.0.0.0/0"] });
    expect((await fetch(`${base}/echo`)).status).toBe(403);
    await close?.();
    base = await serve(counting, { trustedHeader: "X-Real-IP", trustedProxies: ["192.0.2.1"] });
    expect((await fetch(`${base}/echo`)).status).toBe(200);
  });

  it("answers 400 to a request target with a dot segment", async () => {
    const base = await serve(ok);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/`, { path: "/x/%2e%2e/echo" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(`${base}/echo`)).status).toBe(200);
  });

  it("logs a warning when a peer outside trustedProxies sends forwarding headers", async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => { warnings.push(message); } };
    const server = createHttpServer([parseRoute("GET /echo", "echo")], ok, logger, { trustedHeader: "X-Real-IP", trustedProxies: ["192.0.2.1"] });
    const address = await listen(server, 0, "127.0.0.1");
    close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    const base = `http://127.0.0.1:${address.port}`;
    await fetch(`${base}/echo`);
    expect(warnings).toEqual([]);
    await fetch(`${base}/echo`, { headers: { "x-real-ip": "10.9.9.9" } });
    await fetch(`${base}/echo`, { headers: { "x-real-ip": "10.9.9.8" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("127.0.0.1");
  });

  it("answers the health path to a probe without the trusted header, judging it by its peer address", async () => {
    let base = await serve(ok, { trustedHeader: "X-Real-IP" });
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, restartRequired: false });
    expect((await fetch(`${base}/echo`)).status).toBe(403);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(403);
    await close?.();
    base = await serve(ok, { trustedHeader: "X-Real-IP", allow: ["127.0.0.1"] });
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await close?.();
    base = await serve(ok, { trustedHeader: "X-Real-IP", allow: ["10.0.0.0/8"] });
    expect((await fetch(`${base}/health`)).status).toBe(403);
  });

  it("answers 415 to a POST whose body is not JSON, before running the pipeline", async () => {
    let ran = false;
    const server = createHttpServer([parseRoute("POST /echo", "echo")], async () => { ran = true; return { runId: "run-1", status: 200, result: {} }; }, silentLogger);
    const address = await listen(server, 0, "127.0.0.1");
    close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    const base = `http://127.0.0.1:${address.port}`;
    const plain = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"a":1}' });
    expect(plain.status).toBe(415);
    expect(ran).toBe(false);
    const json = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(json.status).toBe(200);
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
