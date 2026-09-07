import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isBinaryResult, requestIdOf, type ContextInput, type UploadedFile } from "../context.ts";
import type { CoreCode } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { RunResult, Runner } from "../runner.ts";

export interface Route {
  method: string;
  segments: readonly string[];
  pipeline: string;
}

export function parseRoute(http: string, pipeline: string): Route {
  const [method, path] = http.split(" ");
  if (method === undefined || path === undefined || !path.startsWith("/")) throw new Error(`invalid http trigger "${http}"`);
  const segments = path === "/" ? [] : path.slice(1).split("/");
  if (segments.some((s) => s === "")) throw new Error(`invalid http trigger "${http}": empty path segment`);
  const wildcard = segments.findIndex((s) => s.startsWith("*"));
  if (wildcard !== -1 && wildcard !== segments.length - 1) throw new Error(`invalid http trigger "${http}": wildcard must be the last segment`);
  return { method, segments, pipeline };
}

/** literal > :param > end of route > *rest, so a literal route wins no matter when it was registered. */
function specificity(segment: string | undefined): number {
  if (segment === undefined) return 1;
  if (segment.startsWith("*")) return 0;
  if (segment.startsWith(":")) return 2;
  return 3;
}

function bySpecificity(a: Route, b: Route): number {
  const len = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < len; i++) {
    const diff = specificity(b.segments[i]) - specificity(a.segments[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function decodeSegment(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** Method plus segment shape; two routes differing only in a param name are the same pattern. */
export function routePattern(route: Route): string {
  return `${route.method} /${route.segments.map((s) => (s.startsWith(":") ? ":" : s.startsWith("*") ? "*" : s)).join("/")}`;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
  const parts = pathname === "/" ? [] : pathname.replace(/\/+$/, "").slice(1).split("/");
  for (const route of [...routes].sort(bySpecificity)) {
    if (route.method !== method) continue;
    const last = route.segments[route.segments.length - 1];
    const wildcard = last?.startsWith("*") ? route.segments.length - 1 : -1;
    if (wildcard === -1 ? route.segments.length !== parts.length : parts.length < wildcard) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i] as string;
      if (i === wildcard) {
        const rest = parts.slice(i).map(decodeSegment);
        // An encoded "/" would make the rest indistinguishable from a deeper path, so it never matches.
        if (rest.some((p) => p === undefined || p.includes("/"))) ok = false;
        else params[seg.slice(1)] = rest.join("/");
        break;
      }
      const part = decodeSegment(parts[i] as string);
      if (part === undefined) ok = false;
      else if (seg.startsWith(":")) params[seg.slice(1)] = part;
      else if (seg !== part) ok = false;
      if (!ok) break;
    }
    if (ok) return { route, params };
  }
  return undefined;
}

export class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyTooLarge(`body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function parseQuery(searchParams: URLSearchParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    payload[key] = values.length > 1 ? values : values[0];
  }
  return payload;
}

export interface ParsedBody {
  payload: Record<string, unknown>;
  files: UploadedFile[];
}

export async function parseRequestBody(contentType: string, body: Uint8Array): Promise<ParsedBody> {
  if (contentType.startsWith("multipart/form-data")) {
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    const form = await new Response(copy.buffer, { headers: { "content-type": contentType } }).formData();
    const payload: Record<string, unknown> = {};
    const files: UploadedFile[] = [];
    for (const [field, value] of form) {
      if (typeof value === "string") payload[field] = value;
      else files.push({ field, filename: value.name, contentType: value.type || "application/octet-stream", data: new Uint8Array(await value.arrayBuffer()) });
    }
    return { payload, files };
  }
  const text = Buffer.from(body).toString("utf8");
  if (text.trim() === "") return { payload: {}, files: [] };
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return { payload: parsed as Record<string, unknown>, files: [] };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export interface ResponseMeta {
  runId?: string;
  requestId?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 1;

function retryAfterSecondsOf(meta: ResponseMeta): number {
  const seconds = meta.retryAfterSeconds;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

export function buildResponse(status: number, body: unknown, meta: ResponseMeta = {}, extraInline: readonly string[] = []): HttpResponse {
  const headers: Record<string, string> = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
  if (meta.runId !== undefined) headers["x-kestrel-run-id"] = meta.runId;
  if (meta.requestId !== undefined) headers["x-request-id"] = meta.requestId;
  if (meta.retryable === true && (status === 429 || status === 503)) headers["retry-after"] = String(retryAfterSecondsOf(meta));
  if (isBinaryResult(body)) {
    return {
      status,
      headers: {
        // Caller headers may add, never weaken: the mandatory ones are spread last.
        ...Object.fromEntries(Object.entries(body.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        ...headers,
        "content-type": body.contentType,
        "content-length": String(body.data.byteLength),
        "content-disposition": disposition(body.contentType, body.filename, extraInline),
        "content-security-policy": "default-src 'none'; sandbox",
      },
      body: body.data,
    };
  }
  return { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body ?? null) };
}

function errorBody(result: RunResult): Record<string, unknown> {
  const body: Record<string, unknown> = { error: result.error, code: result.code, retryable: result.retryable, runId: result.runId };
  if (result.step !== undefined) body.step = result.step;
  if (result.details !== undefined) body.details = result.details;
  return body;
}

function metaOf(result: RunResult): ResponseMeta {
  const meta: ResponseMeta = { runId: result.runId };
  if (result.requestId !== undefined) meta.requestId = result.requestId;
  if (result.retryable !== undefined) meta.retryable = result.retryable;
  const retryAfterSeconds = result.details?.retryAfterSeconds;
  if (typeof retryAfterSeconds === "number") meta.retryAfterSeconds = retryAfterSeconds;
  return meta;
}

export function responseForRun(result: RunResult, extraInline: readonly string[] = []): HttpResponse {
  if (result.status >= 400) return buildResponse(result.status, errorBody(result), metaOf(result), extraInline);
  return buildResponse(result.status, result.result, metaOf(result), extraInline);
}

/** Fixed code for errors raised before a pipeline runs, where there is no KestrelError to read one from. */
const EDGE_CODE_BY_STATUS: Readonly<Record<number, CoreCode>> = {
  400: "VALIDATION",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  500: "INTERNAL",
};

/** The one shape for errors raised before a pipeline runs (unknown route, unreadable body). */
export function errorResponse(status: number, error: string, requestId?: string): HttpResponse {
  const runId = randomUUID();
  const code = EDGE_CODE_BY_STATUS[status] ?? "INTERNAL";
  const body = { error, code, retryable: false, runId };
  return buildResponse(status, body, requestId === undefined ? { runId } : { runId, requestId });
}

const INLINE_SAFE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav"]);

/** RFC 6266: a quoted ASCII fallback, plus filename* only when the name is not printable ASCII. */
export function disposition(contentType: string, filename: string | undefined, extraInline: readonly string[] = []): string {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const mode = INLINE_SAFE.has(mediaType) || extraInline.includes(mediaType) ? "inline" : "attachment";
  if (filename === undefined) return mode;
  const ascii = `${mode}; filename="${filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&")}"`;
  if (/^[\x20-\x7e]*$/.test(filename)) return ascii;
  const encoded = encodeURIComponent(filename).replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${ascii}; filename*=UTF-8''${encoded}`;
}

function sendError(res: ServerResponse, status: number, error: string, requestId?: string): void {
  write(res, errorResponse(status, error, requestId));
}

function write(res: ServerResponse, response: HttpResponse): void {
  res.writeHead(response.status, response.headers);
  res.end(typeof response.body === "string" ? response.body : Buffer.from(response.body));
}

export interface HttpTimeouts {
  requestMs?: number;
  headersMs?: number;
  keepAliveMs?: number;
}

export interface HttpOptions {
  corsOrigin?: string;
  maxBodyBytes?: number;
  trustProxy?: boolean;
  healthPath?: string | null;
  inlineTypes?: readonly string[];
  timeouts?: HttpTimeouts;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? undefined;
}

export function createHttpServer(routes: readonly Route[], run: Runner, logger: Logger, options: HttpOptions = {}): Server {
  const started = Date.now();
  const healthPath = options.healthPath === undefined ? "/health" : options.healthPath;
  const server = createServer((req, res) => {
    if (options.corsOrigin !== undefined) {
      res.setHeader("access-control-allow-origin", options.corsOrigin);
      res.setHeader("access-control-allow-headers", "content-type, authorization");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "x-content-type-options": "nosniff", "cache-control": "no-store", "access-control-max-age": "600" });
        res.end();
        return;
      }
    }
    void handle(req, res).catch((err: unknown) => {
      logger.error("http handler failed", { error: err instanceof Error ? err.stack : String(err) });
      if (!res.headersSent) sendError(res, 500, "internal error", requestIdOf(req.headers["x-request-id"]));
    });
  });
  server.requestTimeout = options.timeouts?.requestMs ?? 30_000;
  server.headersTimeout = options.timeouts?.headersMs ?? 10_000;
  server.keepAliveTimeout = options.timeouts?.keepAliveMs ?? 5_000;
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const requestId = requestIdOf(req.headers["x-request-id"]);
    if (healthPath && url.pathname === healthPath && req.method === "GET") {
      const meta: ResponseMeta = requestId === undefined ? { runId: randomUUID() } : { runId: randomUUID(), requestId };
      return write(res, buildResponse(200, { ok: true, uptimeSeconds: Math.round((Date.now() - started) / 1000) }, meta));
    }
    const begin = performance.now();
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (!match) return sendError(res, 404, `no route for ${req.method} ${url.pathname}`, requestId);

    let body: ParsedBody;
    try {
      body = await parseRequestBody(req.headers["content-type"] ?? "", await readBody(req, options.maxBodyBytes ?? 10 * 1024 * 1024));
    } catch (err) {
      if (err instanceof BodyTooLarge) return sendError(res, 413, err.message, requestId);
      return sendError(res, 400, `invalid body: ${err instanceof Error ? err.message : String(err)}`, requestId);
    }
    const payload: Record<string, unknown> = { ...parseQuery(url.searchParams), ...body.payload };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const input: ContextInput = { trigger: { kind: "http", name: `${req.method} ${url.pathname}` }, payload, params: match.params, headers, files: body.files };
    const ip = clientIp(req, options.trustProxy ?? false);
    if (ip !== undefined) input.ip = ip;

    const result = await run(match.route.pipeline, input);
    logger.info("http", { runId: result.runId, ...(requestId === undefined ? {} : { requestId }), method: req.method, path: url.pathname, pipeline: match.route.pipeline, status: result.status, ms: Math.round((performance.now() - begin) * 100) / 100, ip });
    write(res, responseForRun(result, options.inlineTypes));
  }
}

export function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}
