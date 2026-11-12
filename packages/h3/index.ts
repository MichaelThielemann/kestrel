import { randomUUID } from "node:crypto";
import { appendResponseHeader, eventHandler, getRequestHeaders, getRequestURL, readRawBody, setResponseHeaders, setResponseStatus, type EventHandler, type H3Event } from "h3";
import { bodyRefusal, clientIpResolver, errorResponse, hasDotSegment, httpLogLine, matchRoute, multipartRefusal, parseQuery, parseRequestBody, readRequestBody, requestIdOf, responseForRun, type ClientIpOptions, type ContextInput, type MultipartLimits, type HttpResponse, type Kestrel, type Logger } from "@michaelthielemann/kestrel";

export interface KestrelHandlerOptions extends ClientIpOptions {
  mountPath?: string;
  maxBodyBytes?: number;
  multipart?: MultipartLimits;
  inlineTypes?: readonly string[];
  /** Writes one `logger.info("http", …)` line per request, the same fields as the core server's line; a refusal before the pipeline adds `reason`. Without it the handler logs nothing. */
  logger?: Logger;
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

interface Handled {
  response: HttpResponse;
  pipeline?: string;
  reason?: string;
  declaredBytes?: number;
}

function rawPathname(event: H3Event): string {
  return (event.node.req.originalUrl ?? event.path).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split(/[?#]/, 1)[0] || "/";
}

export function createKestrelHandler(kestrel: KestrelRunner, options: KestrelHandlerOptions = {}): EventHandler {
  const mountPath = (options.mountPath ?? "").replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const resolveClient = clientIpResolver(options);
  const { logger } = options;

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
    let parsed;
    try {
      const raw = WITH_BODY.has(event.method) ? await readBody(event, maxBodyBytes) : undefined;
      parsed = await parseRequestBody(contentType, raw ?? new Uint8Array(), options.multipart);
    } catch (err) {
      return { ...bodyRefusal(err, event.node.req, requestId), pipeline };
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
    if (logger === undefined) return;
    const { response, pipeline, reason, declaredBytes } = handled;
    const path = reason === "invalid path: dot segment" ? rawPathname(event) : getRequestURL(event).pathname;
    logger.info("http", httpLogLine({ runId: response.headers["x-kestrel-run-id"] ?? randomUUID(), requestId, method: event.method, path, pipeline, status: response.status, begin, ip, reason, declaredBytes }));
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
      const runId = randomUUID();
      if (!event.node.res.headersSent) setResponseHeaders(event, requestId === undefined ? { "x-kestrel-run-id": runId } : { "x-kestrel-run-id": runId, "x-request-id": requestId });
      logger?.info("http", httpLogLine({ runId, requestId, method: event.method, path: rawPathname(event), pipeline, status: 500, begin, ip, reason: "handler failed" }));
      throw err;
    }
    report(event, begin, requestId, ip, handled);
    return respond(event, handled.response);
  });
}
