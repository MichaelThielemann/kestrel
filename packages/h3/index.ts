import { randomUUID } from "node:crypto";
import { appendResponseHeader, eventHandler, getRequestHeaders, getRequestURL, readRawBody, setResponseHeaders, setResponseStatus, type EventHandler, type H3Event } from "h3";
import { BodyTooLarge, UnsupportedMediaType, clientIpResolver, errorResponse, hasDotSegment, matchRoute, multipartRefusal, parseQuery, parseRequestBody, readRequestBody, requestIdOf, responseForRun, type ClientIpOptions, type ContextInput, type MultipartLimits, type HttpResponse, type Kestrel, type Logger } from "@michaelthielemann/kestrel";

/** A request the handler answered before any pipeline ran: the fields of its `http` log line, plus the error code it answered with. */
export interface RequestRefusal {
  /** Epoch ms when the handler finished with the request. */
  at: number;
  /** The run id of the error response (`X-Kestrel-Run-Id`); no run exists for it. */
  runId: string;
  requestId?: string;
  method: string;
  /** The URL path without its query string. */
  path: string;
  /** The pipeline the route names; absent when no route matched or the path was refused before routing. */
  pipeline?: string;
  status: number;
  code: string;
  /** Why the request was refused, without any request content: `no route`, `invalid path: dot segment`, `body exceeds <n> bytes`, `invalid body: <cause>`, `unsupported content type`, a multipart limit. */
  reason: string;
  ms: number;
  ip?: string;
}

export interface KestrelHandlerOptions extends ClientIpOptions {
  mountPath?: string;
  maxBodyBytes?: number;
  multipart?: MultipartLimits;
  inlineTypes?: readonly string[];
  /** Writes one `logger.info("http", …)` line per request, the same fields as the core server's line; a refusal before the pipeline adds `reason`. Without it the handler logs nothing. */
  logger?: Logger;
  /** Called once for every request refused before its pipeline ran; a throw is reported to `logger` and never changes the response. */
  onRefusal?: (refusal: RequestRefusal) => void;
}

export type KestrelRunner = Pick<Kestrel, "run" | "triggers">;

function stripMount(pathname: string, mountPath: string): string | null {
  if (mountPath === "" || mountPath === "/") return pathname;
  if (pathname === mountPath) return "/";
  return pathname.startsWith(mountPath + "/") ? pathname.slice(mountPath.length) : null;
}

const WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const routed = new WeakMap<H3Event, string>();

/** The pipeline a `createKestrelHandler` handler routed this event to; `undefined` before it ran or when no route matched. */
export function routedPipeline(event: H3Event): string | undefined {
  return routed.get(event);
}

function preBuffered(event: H3Event): boolean {
  const req = event.node.req;
  return event._requestBody !== undefined || event.web?.request?.body != null || Symbol.for("h3RawBody") in req || "rawBody" in req || "body" in req || "__unenv__" in req;
}

async function readBody(event: H3Event, maxBytes: number): Promise<Uint8Array> {
  const contentLength = event.node.req.headers["content-length"];
  if (!preBuffered(event)) return readRequestBody(event.node.req, maxBytes, contentLength);
  const body = await readRawBody(event, false);
  return readRequestBody(body === undefined ? [] : [body], maxBytes, contentLength);
}

async function respond(event: H3Event, response: HttpResponse): Promise<Buffer | string> {
  setResponseStatus(event, response.status);
  setResponseHeaders(event, response.headers);
  for (const cookie of response.cookies ?? []) appendResponseHeader(event, "set-cookie", cookie);
  return typeof response.body === "string" ? response.body : Buffer.from(response.body);
}

const REFUSAL_CODE: Readonly<Record<number, string>> = { 400: "VALIDATION", 404: "NOT_FOUND", 413: "PAYLOAD_TOO_LARGE", 415: "UNSUPPORTED" };
const REASON_LIMIT = 200;

interface Handled {
  response: HttpResponse;
  pipeline?: string;
  reason?: string;
  declaredBytes?: number;
}

function declaredLength(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

function bodyReason(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid body: malformed JSON";
  const message = err instanceof Error ? err.message : "unreadable";
  return message.startsWith("invalid ") ? message : `invalid body: ${message}`;
}

function bounded(reason: string): string {
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason;
}

function rawPathname(event: H3Event): string {
  return (event.node.req.originalUrl ?? event.path).split("?", 1)[0] ?? "/";
}

export function createKestrelHandler(kestrel: KestrelRunner, options: KestrelHandlerOptions = {}): EventHandler {
  const mountPath = (options.mountPath ?? "").replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const resolveClient = clientIpResolver(options);
  const { logger, onRefusal } = options;

  async function handle(event: H3Event, headers: Record<string, string>, requestId: string | undefined, ip: string | undefined): Promise<Handled> {
    if (hasDotSegment(event.node.req.originalUrl ?? event.path)) return { response: errorResponse(400, "invalid path: dot segment", requestId), reason: "invalid path: dot segment" };
    const url = getRequestURL(event);
    const pathname = stripMount(url.pathname, mountPath);

    const match = pathname === null ? undefined : matchRoute(kestrel.triggers.http, event.method, pathname);
    if (!match) return { response: errorResponse(404, `no route for ${event.method} ${url.pathname}`, requestId), reason: "no route" };
    const pipeline = match.route.pipeline;
    routed.set(event, pipeline);

    const contentType = headers["content-type"] ?? "";
    const refusal = multipartRefusal(match.route, contentType, requestId);
    if (refusal !== undefined) return { response: refusal, pipeline, reason: "this route does not accept multipart/form-data" };
    const tooLarge = (err: BodyTooLarge): Handled => {
      const declaredBytes = declaredLength(headers["content-length"]);
      return { response: errorResponse(413, err.message, requestId), pipeline, reason: err.message, ...(declaredBytes === undefined ? {} : { declaredBytes }) };
    };
    let raw: Uint8Array | undefined;
    try {
      raw = WITH_BODY.has(event.method) ? await readBody(event, maxBodyBytes) : undefined;
    } catch (err) {
      if (err instanceof BodyTooLarge) return tooLarge(err);
      throw err;
    }
    let parsed;
    try {
      parsed = await parseRequestBody(contentType, raw ?? new Uint8Array(), options.multipart);
    } catch (err) {
      if (err instanceof BodyTooLarge) return tooLarge(err);
      if (err instanceof UnsupportedMediaType) return { response: errorResponse(415, err.message, requestId), pipeline, reason: "unsupported content type" };
      return { response: errorResponse(400, `invalid body: ${err instanceof Error ? err.message : String(err)}`, requestId), pipeline, reason: bodyReason(err) };
    }

    const query = parseQuery(url.searchParams);
    const input: ContextInput = {
      trigger: { kind: "http", name: `${event.method} ${pathname ?? url.pathname}` },
      payload: { ...query, ...parsed.payload },
      body: parsed.payload,
      query,
      params: match.params,
      headers,
      files: parsed.files,
    };
    if (ip !== undefined) input.ip = ip;

    return { response: responseForRun(await kestrel.run(pipeline, input), options.inlineTypes), pipeline };
  }

  function report(event: H3Event, begin: number, requestId: string | undefined, ip: string | undefined, handled: Handled): void {
    if (logger === undefined && onRefusal === undefined) return;
    const { response, pipeline, reason, declaredBytes } = handled;
    const runId = response.headers["x-kestrel-run-id"] ?? randomUUID();
    const path = reason === "invalid path: dot segment" ? rawPathname(event) : getRequestURL(event).pathname;
    const ms = Math.round((performance.now() - begin) * 100) / 100;
    logger?.info("http", {
      runId,
      ...(requestId === undefined ? {} : { requestId }),
      method: event.method,
      path,
      ...(pipeline === undefined ? {} : { pipeline }),
      status: response.status,
      ms,
      ...(ip === undefined ? {} : { ip }),
      ...(reason === undefined ? {} : { reason: bounded(reason) }),
      ...(declaredBytes === undefined ? {} : { declaredBytes }),
    });
    if (reason === undefined || onRefusal === undefined) return;
    const refusal: RequestRefusal = {
      at: Date.now(),
      runId,
      ...(requestId === undefined ? {} : { requestId }),
      method: event.method,
      path,
      ...(pipeline === undefined ? {} : { pipeline }),
      status: response.status,
      code: REFUSAL_CODE[response.status] ?? "INTERNAL",
      reason: bounded(reason),
      ms,
      ...(ip === undefined ? {} : { ip }),
    };
    try {
      onRefusal(refusal);
    } catch (err) {
      logger?.error("onRefusal threw", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return eventHandler(async (event) => {
    const begin = performance.now();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(getRequestHeaders(event))) if (typeof v === "string") headers[k] = v;
    const requestId = requestIdOf(headers["x-request-id"]);
    const { ip } = resolveClient(event.node.req);
    let handled: Handled;
    try {
      handled = await handle(event, headers, requestId, ip);
    } catch (err) {
      const pipeline = routed.get(event);
      logger?.info("http", {
        runId: randomUUID(),
        ...(requestId === undefined ? {} : { requestId }),
        method: event.method,
        path: rawPathname(event),
        ...(pipeline === undefined ? {} : { pipeline }),
        status: 500,
        ms: Math.round((performance.now() - begin) * 100) / 100,
        ...(ip === undefined ? {} : { ip }),
        reason: "handler failed",
      });
      throw err;
    }
    report(event, begin, requestId, ip, handled);
    return respond(event, handled.response);
  });
}
