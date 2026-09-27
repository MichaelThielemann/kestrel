import { eventHandler, getRequestHeaders, getRequestURL, readRawBody, setResponseHeaders, setResponseStatus, type EventHandler, type H3Event } from "h3";
import { BodyTooLarge, clientIpResolver, errorResponse, hasDotSegment, matchRoute, multipartRefusal, parseQuery, parseRequestBody, readRequestBody, requestIdOf, responseForRun, type ClientIpOptions, type ContextInput, type MultipartLimits, type HttpResponse, type Kestrel } from "@michaelthielemann/kestrel";

export interface KestrelHandlerOptions extends ClientIpOptions {
  mountPath?: string;
  maxBodyBytes?: number;
  multipart?: MultipartLimits;
  inlineTypes?: readonly string[];
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
  return typeof response.body === "string" ? response.body : Buffer.from(response.body);
}

export function createKestrelHandler(kestrel: KestrelRunner, options: KestrelHandlerOptions = {}): EventHandler {
  const mountPath = (options.mountPath ?? "").replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const resolveClient = clientIpResolver(options);

  return eventHandler(async (event) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(getRequestHeaders(event))) if (typeof v === "string") headers[k] = v;
    const requestId = requestIdOf(headers["x-request-id"]);
    if (hasDotSegment(event.node.req.originalUrl ?? event.path) || hasDotSegment(event.path)) return respond(event, errorResponse(400, "invalid path: dot segment", requestId));
    const url = getRequestURL(event);
    const pathname = stripMount(url.pathname, mountPath);

    const match = pathname === null ? undefined : matchRoute(kestrel.triggers.http, event.method, pathname);
    if (!match) return respond(event, errorResponse(404, `no route for ${event.method} ${url.pathname}`, requestId));
    routed.set(event, match.route.pipeline);

    const contentType = headers["content-type"] ?? "";
    const refusal = multipartRefusal(match.route, contentType, requestId);
    if (refusal !== undefined) return respond(event, refusal);
    let raw: Uint8Array | undefined;
    try {
      raw = WITH_BODY.has(event.method) ? await readBody(event, maxBodyBytes) : undefined;
    } catch (err) {
      if (err instanceof BodyTooLarge) return respond(event, errorResponse(413, err.message, requestId));
      throw err;
    }
    let parsed;
    try {
      parsed = await parseRequestBody(contentType, raw ?? new Uint8Array(), options.multipart);
    } catch (err) {
      if (err instanceof BodyTooLarge) return respond(event, errorResponse(413, err.message, requestId));
      return respond(event, errorResponse(400, `invalid body: ${err instanceof Error ? err.message : String(err)}`, requestId));
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
    const { ip } = resolveClient(event.node.req);
    if (ip !== undefined) input.ip = ip;

    return respond(event, responseForRun(await kestrel.run(match.route.pipeline, input), options.inlineTypes));
  });
}
