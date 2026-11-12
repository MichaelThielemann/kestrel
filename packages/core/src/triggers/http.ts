import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { boundaryCast } from "../cast.ts";
import { isBinaryResult, requestIdOf, type ContextInput, type UploadedFile } from "../context.ts";
import type { InstanceHealth } from "../defineModule.ts";
import type { CoreCode } from "../errors.ts";
import { logWarn, type Logger } from "../logger.ts";
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

/**
 * Whether the path of a raw request target has a `.` or `..` segment, literal or percent-encoded, with
 * `/` or `\` as separator. A URL parser resolves such a segment, so the routed path would differ from
 * the one the request named; both HTTP paths answer 400 instead.
 */
export function hasDotSegment(target: string): boolean {
  const path = target.split(/[?#]/, 1)[0] ?? "";
  return path.split(/[/\\]/).some((segment) => {
    const plain = segment.replace(/%2e/gi, ".");
    return plain === "." || plain === "..";
  });
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

/** A request body whose declared type is neither JSON nor multipart form data. */
export class UnsupportedMediaType extends Error {}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;

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
  return (contentType.split(";", 1)[0] ?? "").trim().toLowerCase() === "multipart/form-data";
}

class InvalidMultipart extends Error {
  constructor(reason: string) {
    super(`invalid multipart body: ${reason}`);
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function mediaTypeParameters(contentType: string): Map<string, string> {
  const params = new Map<string, string>();
  let at = contentType.indexOf(";");
  if (at === -1) return params;
  while (at < contentType.length) {
    at += 1;
    while (contentType[at] === " " || contentType[at] === "\t") at += 1;
    if (at >= contentType.length) break;
    if (contentType[at] === ";") continue;
    const eq = contentType.indexOf("=", at);
    if (eq === -1) throw new InvalidMultipart("malformed Content-Type parameter");
    const name = contentType.slice(at, eq).toLowerCase();
    if (!TOKEN.test(name)) throw new InvalidMultipart("malformed Content-Type parameter");
    let value = "";
    at = eq + 1;
    if (contentType[at] === '"') {
      at += 1;
      for (;;) {
        const c = contentType[at];
        if (c === undefined) throw new InvalidMultipart("unterminated quoted Content-Type parameter");
        if (c === '"') break;
        if (c === "\\") at += 1;
        value += contentType[at] ?? "";
        at += 1;
      }
      at += 1;
    } else {
      const stop = contentType.indexOf(";", at);
      value = contentType.slice(at, stop === -1 ? contentType.length : stop).trimEnd();
      if (!TOKEN.test(value)) throw new InvalidMultipart("malformed Content-Type parameter");
      at = stop === -1 ? contentType.length : stop;
    }
    while (contentType[at] === " " || contentType[at] === "\t") at += 1;
    if (at < contentType.length && contentType[at] !== ";") throw new InvalidMultipart("malformed Content-Type parameter");
    if (params.has(name)) throw new InvalidMultipart(`duplicate Content-Type parameter "${name}"`);
    params.set(name, value);
  }
  return params;
}

function boundaryOf(contentType: string): string {
  const boundary = mediaTypeParameters(contentType).get("boundary");
  if (boundary === undefined || boundary.length === 0 || boundary.length > 70) throw new InvalidMultipart("missing or malformed boundary");
  return boundary;
}

function tooMany(count: number, limit: number, what: string): void {
  if (count > limit) throw new BodyTooLarge(`multipart body has more than ${limit} ${what}`);
}

function formDataName(raw: string): string {
  return raw.replace(/%0A/gi, "\n").replace(/%0D/gi, "\r").replace(/%22/gi, '"');
}

function dispositionOf(headers: string): { name: string; filename?: string } {
  const line = headers.split("\r\n").find((l) => /^content-disposition\s*:/i.test(l));
  if (line === undefined) throw new InvalidMultipart("part without Content-Disposition");
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (!/^form-data\s*(;|$)/i.test(value)) throw new InvalidMultipart("part is not form-data");
  const found: Record<string, string> = {};
  for (const match of value.matchAll(/;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/g)) {
    const key = (match[1] ?? "").toLowerCase();
    if (key !== "name" && key !== "filename") continue;
    if (key in found) throw new InvalidMultipart(`duplicate ${key} in Content-Disposition`);
    found[key] = formDataName(match[2] ?? match[3] ?? "");
  }
  if (found.name === undefined) throw new InvalidMultipart("part without a name");
  return found.filename === undefined ? { name: found.name } : { name: found.name, filename: found.filename };
}

function partContentType(headers: string): string {
  const line = headers.split("\r\n").find((l) => /^content-type\s*:/i.test(l));
  const value = line === undefined ? "" : line.slice(line.indexOf(":") + 1).trim().toLowerCase();
  return value === "" ? "application/octet-stream" : value;
}

const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");

function parseMultipart(body: Uint8Array, contentType: string, limits: MultipartLimits): ParsedBody {
  const boundary = boundaryOf(contentType);
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const opening = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const payload: Record<string, unknown> = {};
  const files: UploadedFile[] = [];
  let at = buf.subarray(0, opening.length).equals(opening) ? 0 : buf.indexOf(delimiter);
  if (at === -1) throw new InvalidMultipart("no boundary delimiter");
  if (at > 0) at += CRLF.length;
  let parts = 0;
  let fileCount = 0;
  for (;;) {
    let cursor = at + opening.length;
    if (buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d) return { payload, files };
    while (buf[cursor] === 0x20 || buf[cursor] === 0x09) cursor += 1;
    if (!buf.subarray(cursor, cursor + CRLF.length).equals(CRLF)) throw new InvalidMultipart("malformed boundary delimiter");
    parts += 1;
    tooMany(parts, limits.maxParts, "parts");
    const headersStart = cursor + CRLF.length;
    const emptyHeaders = buf.subarray(headersStart, headersStart + CRLF.length).equals(CRLF);
    const headersEnd = emptyHeaders ? headersStart : buf.indexOf(HEADERS_END, headersStart);
    if (headersEnd === -1) throw new InvalidMultipart("unterminated part headers");
    const headers = buf.subarray(headersStart, headersEnd).toString("utf8");
    const disposition = dispositionOf(headers);
    if (disposition.filename !== undefined) fileCount += 1;
    tooMany(fileCount, limits.maxFiles, "files");
    tooMany(parts - fileCount, limits.maxFields, "fields");
    const dataStart = headersEnd + (emptyHeaders ? CRLF.length : HEADERS_END.length);
    const next = buf.indexOf(delimiter, dataStart);
    if (next === -1) throw new InvalidMultipart("no closing boundary delimiter");
    const data = buf.subarray(dataStart, next);
    if (disposition.filename === undefined) payload[disposition.name] = data.toString("utf8");
    else files.push({ field: disposition.name, filename: disposition.filename, contentType: partContentType(headers), data: Uint8Array.prototype.slice.call(data) });
    at = next + CRLF.length;
  }
}

/**
 * Parses a JSON or `multipart/form-data` body. Multipart is parsed part by part against the one
 * `boundary` of a well-formed `Content-Type` (a malformed or repeated parameter is refused), and the
 * first part past `limits` throws `BodyTooLarge` before it is decoded; a body that never reaches its
 * closing delimiter is refused.
 */
export async function parseRequestBody(contentType: string, body: Uint8Array, limits: MultipartLimits = DEFAULT_MULTIPART_LIMITS): Promise<ParsedBody> {
  if (isMultipart(contentType)) return parseMultipart(body, contentType, limits);
  const text = Buffer.from(body).toString("utf8");
  if (text.trim() === "") return { payload: {}, files: [] };
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!JSON_TYPE.test(mediaType)) throw new UnsupportedMediaType(`content type "${mediaType}" is not supported; send application/json or multipart/form-data`);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("body must be a JSON object");
  return { payload: parsed, files: [] };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Further `set-cookie` values, each sent as a header of its own after any `set-cookie` in `headers`. */
  cookies?: string[];
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

export function buildResponse(status: number, body: unknown, meta: ResponseMeta = {}, extraInline: readonly string[] = [], extraHeaders: Record<string, string> = {}): HttpResponse {
  const added = Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  const headers: Record<string, string> = { ...added, "x-content-type-options": "nosniff", "cache-control": "no-store" };
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
  const response = result.status >= 400 ? buildResponse(result.status, errorBody(result), metaOf(result), extraInline, result.headers) : buildResponse(result.status, result.result, metaOf(result), extraInline, result.headers);
  return result.cookies === undefined || result.cookies.length === 0 ? response : { ...response, cookies: result.cookies };
}

function responseCookies(response: HttpResponse): string[] {
  const own = response.headers["set-cookie"];
  return [...(own === undefined ? [] : [own]), ...(response.cookies ?? [])];
}

const EDGE_CODE_BY_STATUS: Readonly<Record<number, CoreCode>> = {
  400: "VALIDATION",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  408: "TRANSIENT",
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

function write(res: ServerResponse, response: HttpResponse): void {
  const cookies = responseCookies(response);
  res.writeHead(response.status, cookies.length > 0 ? { ...response.headers, "set-cookie": cookies } : response.headers);
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
  /** Set when a peer outside `trustedProxies` sent the forwarding header the policy reads; the header was ignored. */
  forwardingIgnored?: true;
}

/** Options of `forwardingWarner`. */
export interface ForwardingWarnerOptions {
  /** How long one peer stays quiet after a warning; default one hour. */
  intervalMs?: number;
  /** How many peers are remembered before the memory is cleared; default 1000. */
  maxPeers?: number;
  now?: () => number;
}

/**
 * A rate-limited warning for requests whose forwarding headers were ignored because the peer is not in
 * `trustedProxies`: one line per peer and interval, so a proxy missing from the list shows up in the log.
 */
export function forwardingWarner(warn: (message: string) => void, options: ForwardingWarnerOptions = {}): (peer: string | undefined) => void {
  const { intervalMs = 60 * 60 * 1000, maxPeers = 1000, now = Date.now } = options;
  const last = new Map<string, number>();
  return (peer) => {
    const key = peer ?? "local";
    const at = now();
    const previous = last.get(key);
    if (previous !== undefined && at - previous < intervalMs) return;
    if (!last.has(key) && last.size >= maxPeers) last.clear();
    last.set(key, at);
    warn(`forwarding header from ${key} ignored: the peer is not in trustedProxies; list the proxy there if it is one`);
  };
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
    if (header === undefined && !trustProxy) return addressed(peer);
    if (!fromProxy) {
      const forwarded = req.headers[header ?? "x-forwarded-for"] !== undefined;
      return forwarded ? { ...addressed(peer), forwardingIgnored: true } : addressed(peer);
    }
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

interface Answer {
  response: HttpResponse;
  pipeline?: string;
  reason?: string;
  declaredBytes?: number;
  path?: string;
}

const REASON_LIMIT = 200;

/** One request as its `http` log line records it. */
export interface HttpLogEntry {
  /** The `X-Kestrel-Run-Id` of the response. */
  runId: string | undefined;
  requestId?: string | undefined;
  method: string | undefined;
  /** The URL path, without the query string. */
  path: string;
  pipeline?: string | undefined;
  status: number;
  /** The `performance.now()` at which the request arrived; `ms` runs from it. */
  begin: number;
  ip?: string | undefined;
  reason?: string | undefined;
  declaredBytes?: number | undefined;
}

/**
 * The fields of the `http` line both HTTP paths log for one request: absent values are left out,
 * `reason` is cut to 200 characters and `ms` is the time since `begin`, rounded to 0.01.
 */
export function httpLogLine(entry: HttpLogEntry): Record<string, unknown> {
  const { runId, requestId, method, path, pipeline, status, begin, ip, reason, declaredBytes } = entry;
  return {
    runId,
    ...(requestId === undefined ? {} : { requestId }),
    method,
    path,
    ...(pipeline === undefined ? {} : { pipeline }),
    status,
    ms: Math.round((performance.now() - begin) * 100) / 100,
    ...(ip === undefined ? {} : { ip }),
    ...(reason === undefined ? {} : { reason: reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason }),
    ...(declaredBytes === undefined ? {} : { declaredBytes }),
  };
}

/** A request whose body could not be read or parsed, as both HTTP paths answer and log it. */
export interface BodyRefusal {
  response: HttpResponse;
  reason: string;
  /** The `Content-Length` the request declared; set when the body was too large or did not arrive. */
  declaredBytes?: number;
}

/** The parts of a Node request `bodyRefusal` reads. */
export interface BodyRequest {
  headers: IncomingHttpHeaders;
  socket?: { errored?: Error | null } | null;
}

function declaredLength(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

function errorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === "string" ? value.code : undefined;
}

function bodyReason(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid body: malformed JSON";
  const message = err instanceof Error ? err.message : "unreadable";
  return message.startsWith("invalid ") ? message : `invalid body: ${message}`;
}

/**
 * Maps an error thrown by `readRequestBody` or `parseRequestBody` to the refusal for it: 413 for
 * `BodyTooLarge`, 415 for `UnsupportedMediaType`, 408 when the server's request timeout ended the
 * read, 400 `body not received: connection closed` when the client closed the connection first, and
 * 400 `invalid body: …` for a body that arrived but does not parse.
 */
export function bodyRefusal(err: unknown, req: BodyRequest, requestId?: string): BodyRefusal {
  const contentLength = req.headers["content-length"];
  const declared = declaredLength(contentLength);
  const withDeclared = (refusal: BodyRefusal): BodyRefusal => (declared === undefined ? refusal : { ...refusal, declaredBytes: declared });
  if (err instanceof BodyTooLarge) return withDeclared({ response: errorResponse(413, err.message, requestId), reason: err.message });
  if (err instanceof UnsupportedMediaType) return { response: errorResponse(415, err.message, requestId), reason: "unsupported content type" };
  const socketError = req.socket?.errored ?? null;
  if (errorCode(socketError) === "ERR_HTTP_REQUEST_TIMEOUT") return withDeclared({ response: errorResponse(408, "request timeout", requestId), reason: "body not received: request timeout" });
  if (socketError !== null || errorCode(err) === "ECONNRESET") return withDeclared({ response: errorResponse(400, "connection closed", requestId), reason: "body not received: connection closed" });
  return { response: errorResponse(400, `invalid body: ${err instanceof Error ? err.message : String(err)}`, requestId), reason: bodyReason(err) };
}

function rawPath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?", 1)[0] ?? "/";
}

function refused(status: number, error: string, requestId: string | undefined, reason: string, extra: Omit<Answer, "response" | "reason"> = {}): Answer {
  return { response: errorResponse(status, error, requestId), reason, ...extra };
}

export function createHttpServer(routes: readonly Route[], run: Runner, logger: Logger, options: HttpOptions = {}): Server {
  const healthPath = options.healthPath === undefined ? "/health" : options.healthPath;
  const allowlist = createAllowlist(options.allow ?? []);
  const resolveClient = clientIpResolver(options);
  const warnForwarding = forwardingWarner((message) => logWarn(logger, message));
  const server = createServer((req, res) => {
    const begin = performance.now();
    const requestId = requestIdOf(req.headers["x-request-id"]);
    const client = resolveClient(req);
    if (client.forwardingIgnored) warnForwarding(req.socket.remoteAddress);
    const probe = healthPath !== null && req.method === "GET" && rawPath(req) === healthPath;
    const ip = client.missingHeader && probe ? req.socket.remoteAddress : client.ip;
    if ((client.missingHeader && !probe) || (allowlist !== null && !allowlist.check(ip))) {
      const answer = refused(403, "forbidden", requestId, client.missingHeader ? "missing trusted client header" : "client not allowed", { path: rawPath(req) });
      logRequest(req, begin, requestId, ip, answer);
      write(res, answer.response);
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
    void answer(req, res, begin, requestId, ip).catch((err: unknown) => {
      logger.error("http handler failed", { error: err instanceof Error ? err.stack : String(err) });
      if (!res.headersSent) write(res, errorResponse(500, "internal error", requestId));
    });
  });
  server.requestTimeout = options.timeouts?.requestMs ?? 30_000;
  server.headersTimeout = options.timeouts?.headersMs ?? 10_000;
  server.keepAliveTimeout = options.timeouts?.keepAliveMs ?? 5_000;
  return server;

  async function answer(req: IncomingMessage, res: ServerResponse, begin: number, requestId: string | undefined, ip: string | undefined): Promise<void> {
    let pipeline: string | undefined;
    let answered: Answer | undefined;
    try {
      answered = await handle(req, res, requestId, ip, (name) => { pipeline = name; });
    } catch (err) {
      logger.error("http handler failed", { error: err instanceof Error ? err.stack : String(err) });
      answered = refused(500, "internal error", requestId, "handler failed", { path: rawPath(req), ...(pipeline === undefined ? {} : { pipeline }) });
    }
    if (answered === undefined) return;
    logRequest(req, begin, requestId, ip, answered);
    if (!res.headersSent) write(res, answered.response);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, requestId: string | undefined, ip: string | undefined, routedTo: (pipeline: string) => void): Promise<Answer | undefined> {
    if (hasDotSegment(req.url ?? "/")) return refused(400, "invalid path: dot segment", requestId, "invalid path: dot segment", { path: rawPath(req) });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (healthPath && url.pathname === healthPath && req.method === "GET") {
      const meta: ResponseMeta = requestId === undefined ? { runId: randomUUID() } : { runId: randomUUID(), requestId };
      const { ok, restartRequired } = options.health?.() ?? { ok: true, restartRequired: false };
      write(res, buildResponse(restartRequired ? 503 : 200, { ok, restartRequired }, meta));
      return undefined;
    }
    const path = url.pathname;
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (!match) return refused(404, `no route for ${req.method} ${url.pathname}`, requestId, "no route", { path });
    const pipeline = match.route.pipeline;
    routedTo(pipeline);

    const contentType = req.headers["content-type"] ?? "";
    const refusal = multipartRefusal(match.route, contentType, requestId);
    if (refusal !== undefined) return { response: refusal, pipeline, path, reason: "this route does not accept multipart/form-data" };
    let body: ParsedBody;
    try {
      body = await parseRequestBody(contentType, await readRequestBody(req, options.maxBodyBytes ?? 10 * 1024 * 1024, req.headers["content-length"]), options.multipart);
    } catch (err) {
      return { ...bodyRefusal(err, req, requestId), pipeline, path };
    }
    const query = parseQuery(url.searchParams);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const input: ContextInput = { trigger: { kind: "http", name: `${req.method} ${url.pathname}` }, payload: { ...query, ...body.payload }, body: body.payload, query, params: match.params, headers, files: body.files };
    if (ip !== undefined) input.ip = ip;

    return { response: responseForRun(await run(pipeline, input), options.inlineTypes), pipeline, path };
  }

  function logRequest(req: IncomingMessage, begin: number, requestId: string | undefined, ip: string | undefined, answer: Answer): void {
    const { response, pipeline, reason, declaredBytes } = answer;
    logger.info("http", httpLogLine({ runId: response.headers["x-kestrel-run-id"], requestId, method: req.method, path: answer.path ?? rawPath(req), pipeline, status: response.status, begin, ip, reason, declaredBytes }));
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
