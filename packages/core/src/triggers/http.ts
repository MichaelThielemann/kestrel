import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { boundaryCast } from "../cast.ts";
import { isBinaryResult, requestIdOf, type ContextInput, type UploadedFile } from "../context.ts";
import type { InstanceHealth } from "../defineModule.ts";
import type { CoreCode } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { RunResult, Runner } from "../runner.ts";
import { createAllowlist } from "./allowlist.ts";
import { isRecord } from "../guards.ts";

export interface Route {
  method: string;
  segments: readonly string[];
  pipeline: string;
  /**
   * Whether the pipeline reads `ctx.files`. `false` makes both HTTP paths answer 415 to a multipart body
   * before reading it; boot sets it for every route, and a route without it accepts multipart.
   */
  files?: boolean;
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
    for (const [i, seg] of route.segments.entries()) {
      if (i === wildcard) {
        const rest = parts.slice(i).map(decodeSegment);
        if (rest.some((p) => p === undefined || p.includes("/"))) ok = false;
        else params[seg.slice(1)] = rest.join("/");
        break;
      }
      const raw = parts[i];
      const part = raw === undefined ? undefined : decodeSegment(raw);
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

/**
 * Reads a request body into one buffer, throwing `BodyTooLarge` before the first chunk when the declared
 * `Content-Length` exceeds `maxBytes`, and otherwise as soon as the bytes read do; no chunk is pulled after that.
 */
export async function readRequestBody(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number, contentLength?: string): Promise<Buffer> {
  const declared = contentLength === undefined || !/^\d+$/.test(contentLength.trim()) ? undefined : Number(contentLength.trim());
  if (declared !== undefined && declared > maxBytes) throw new BodyTooLarge(`body exceeds ${maxBytes} bytes`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new BodyTooLarge(`body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
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

/** Caps on the parts of one `multipart/form-data` body; a part with a `filename` is a file, any other a field. */
export interface MultipartLimits {
  maxParts: number;
  maxFiles: number;
  maxFields: number;
}

/** The default `MultipartLimits`. */
export const DEFAULT_MULTIPART_LIMITS: MultipartLimits = { maxParts: 120, maxFiles: 20, maxFields: 100 };

/** Whether a `Content-Type` announces a `multipart/form-data` body. */
export function isMultipart(contentType: string): boolean {
  return contentType.trim().toLowerCase().startsWith("multipart/form-data");
}

function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

function tooMany(count: number, limit: number, what: string): void {
  if (count > limit) throw new BodyTooLarge(`multipart body has more than ${limit} ${what}`);
}

function countParts(body: Uint8Array, contentType: string, limits: MultipartLimits): void {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) return;
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const opening = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let parts = 0;
  let files = 0;
  let at = buf.indexOf(opening);
  let length = opening.length;
  while (at !== -1) {
    const start = at + length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) return;
    parts += 1;
    tooMany(parts, limits.maxParts, "parts");
    const headersEnd = buf.indexOf("\r\n\r\n", start);
    const headers = buf.subarray(start, headersEnd === -1 ? buf.length : headersEnd).toString("latin1");
    if (/;\s*filename\*?\s*=/i.test(headers)) files += 1;
    tooMany(files, limits.maxFiles, "files");
    tooMany(parts - files, limits.maxFields, "fields");
    if (headersEnd === -1) return;
    at = buf.indexOf(delimiter, headersEnd);
    length = delimiter.length;
  }
}

/**
 * Parses a JSON or `multipart/form-data` body. A multipart body is scanned part by part first and
 * rejected with `BodyTooLarge` at the first part past `limits`, before any part is decoded.
 */
export async function parseRequestBody(contentType: string, body: Uint8Array, limits: MultipartLimits = DEFAULT_MULTIPART_LIMITS): Promise<ParsedBody> {
  if (isMultipart(contentType)) {
    countParts(body, contentType, limits);
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    const form = await new Response(copy.buffer, { headers: { "content-type": contentType } }).formData();
    const payload: Record<string, unknown> = {};
    const files: UploadedFile[] = [];
    const entries = [...form];
    const fileCount = entries.filter(([, value]) => typeof value !== "string").length;
    tooMany(entries.length, limits.maxParts, "parts");
    tooMany(fileCount, limits.maxFiles, "files");
    tooMany(entries.length - fileCount, limits.maxFields, "fields");
    for (const [field, value] of entries) {
      if (typeof value === "string") payload[field] = value;
      else files.push({ field, filename: value.name, contentType: value.type || "application/octet-stream", data: new Uint8Array(await value.arrayBuffer()) });
    }
    return { payload, files };
  }
  const text = Buffer.from(body).toString("utf8");
  if (text.trim() === "") return { payload: {}, files: [] };
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("body must be a JSON object");
  return { payload: parsed, files: [] };
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
    const own = Object.fromEntries(Object.entries(body.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const ownCaching = own["cache-control"]?.trim();
    return {
      status,
      headers: {
        ...own,
        ...headers,
        ...(ownCaching === undefined || ownCaching === "" ? {} : { "cache-control": ownCaching }),
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

const EDGE_CODE_BY_STATUS: Readonly<Record<number, CoreCode>> = {
  400: "VALIDATION",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED",
  500: "INTERNAL",
};

/** The 415 answer, before any body is read, to a multipart body for a route whose pipeline reads no files. */
export function multipartRefusal(route: Route, contentType: string, requestId?: string): HttpResponse | undefined {
  if (route.files !== false || !isMultipart(contentType)) return undefined;
  return errorResponse(415, "this route does not accept multipart/form-data", requestId);
}

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

export interface ClientIpOptions {
  trustProxy?: boolean;
  proxyHops?: number;
  trustedHeader?: string;
  /**
   * Peers whose forwarding headers are believed, as addresses or CIDR ranges; default `LOOPBACK_PROXIES`.
   * A request from any other peer is attributed to the peer itself. A connection without a peer address
   * (a Unix domain socket, an in-process call) counts as loopback.
   */
  trustedProxies?: readonly string[];
}

/** The default `trustedProxies`: the IPv4 and IPv6 loopback ranges. */
export const LOOPBACK_PROXIES: readonly string[] = ["127.0.0.0/8", "::1"];

/** The part of an incoming request the client address is derived from. */
export interface PeerRequest {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string | undefined } | null;
}

/** The client address of one request under a peer policy. */
export interface ClientAddress {
  /** The client address; absent when none can be derived. */
  ip?: string;
  /** `true` when `trustedHeader` is set and a trusted proxy sent the request without it. */
  missingHeader: boolean;
}

export interface HttpOptions extends ClientIpOptions {
  allow?: readonly string[];
  corsOrigin?: string;
  maxBodyBytes?: number;
  multipart?: MultipartLimits;
  healthPath?: string | null;
  health?: () => Pick<InstanceHealth, "ok" | "restartRequired">;
  inlineTypes?: readonly string[];
  timeouts?: HttpTimeouts;
}

function headerValues(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function addressed(ip: string | undefined): ClientAddress {
  return ip === undefined ? { missingHeader: false } : { ip, missingHeader: false };
}

/**
 * Compiles a peer policy once into a function that derives each request's client address. Forwarding
 * headers count only from a peer in `trustedProxies`: `trustedHeader` gives the value that peer set last,
 * `trustProxy` the `X-Forwarded-For` entry `proxyHops` from the right. Throws on an invalid
 * `trustedProxies` entry.
 */
export function clientIpResolver(options: boolean | ClientIpOptions = {}): (req: PeerRequest) => ClientAddress {
  const { trustProxy = false, proxyHops = 1, trustedHeader, trustedProxies = LOOPBACK_PROXIES } = typeof options === "boolean" ? { trustProxy: options } : options;
  const proxies = createAllowlist(trustedProxies);
  const header = trustedHeader?.toLowerCase();
  return (req) => {
    const peer = req.socket?.remoteAddress || undefined;
    const fromProxy = proxies !== null && proxies.check(peer ?? "127.0.0.1");
    if (!fromProxy || (header === undefined && !trustProxy)) return addressed(peer);
    if (header !== undefined) {
      const ip = headerValues(req.headers[header]).at(-1);
      return ip === undefined ? { missingHeader: true } : addressed(ip);
    }
    const chain = headerValues(req.headers["x-forwarded-for"]);
    return addressed(chain.length >= proxyHops ? chain[chain.length - proxyHops] : undefined);
  };
}

/** The client address of one request under a peer policy (see `clientIpResolver`). */
export function clientIp(req: PeerRequest, options: boolean | ClientIpOptions = {}): string | undefined {
  return clientIpResolver(options)(req).ip;
}

export function createHttpServer(routes: readonly Route[], run: Runner, logger: Logger, options: HttpOptions = {}): Server {
  const healthPath = options.healthPath === undefined ? "/health" : options.healthPath;
  const allowlist = createAllowlist(options.allow ?? []);
  const resolveClient = clientIpResolver(options);
  const server = createServer((req, res) => {
    const client = resolveClient(req);
    if (client.missingHeader || (allowlist !== null && !allowlist.check(client.ip))) {
      sendError(res, 403, "forbidden", requestIdOf(req.headers["x-request-id"]));
      return;
    }
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
    void handle(req, res, client.ip).catch((err: unknown) => {
      logger.error("http handler failed", { error: err instanceof Error ? err.stack : String(err) });
      if (!res.headersSent) sendError(res, 500, "internal error", requestIdOf(req.headers["x-request-id"]));
    });
  });
  server.requestTimeout = options.timeouts?.requestMs ?? 30_000;
  server.headersTimeout = options.timeouts?.headersMs ?? 10_000;
  server.keepAliveTimeout = options.timeouts?.keepAliveMs ?? 5_000;
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse, ip: string | undefined): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const requestId = requestIdOf(req.headers["x-request-id"]);
    if (healthPath && url.pathname === healthPath && req.method === "GET") {
      const meta: ResponseMeta = requestId === undefined ? { runId: randomUUID() } : { runId: randomUUID(), requestId };
      const { ok, restartRequired } = options.health?.() ?? { ok: true, restartRequired: false };
      return write(res, buildResponse(restartRequired ? 503 : 200, { ok, restartRequired }, meta));
    }
    const begin = performance.now();
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (!match) return sendError(res, 404, `no route for ${req.method} ${url.pathname}`, requestId);

    const contentType = req.headers["content-type"] ?? "";
    const refusal = multipartRefusal(match.route, contentType, requestId);
    if (refusal !== undefined) return write(res, refusal);
    let body: ParsedBody;
    try {
      body = await parseRequestBody(contentType, await readRequestBody(req, options.maxBodyBytes ?? 10 * 1024 * 1024, req.headers["content-length"]), options.multipart);
    } catch (err) {
      if (err instanceof BodyTooLarge) return sendError(res, 413, err.message, requestId);
      return sendError(res, 400, `invalid body: ${err instanceof Error ? err.message : String(err)}`, requestId);
    }
    const query = parseQuery(url.searchParams);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const input: ContextInput = { trigger: { kind: "http", name: `${req.method} ${url.pathname}` }, payload: { ...query, ...body.payload }, body: body.payload, query, params: match.params, headers, files: body.files };
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
      resolve(boundaryCast<AddressInfo>(server.address(), "host"));
    });
  });
}
