import { eventHandler, getRequestHeaders, getRequestURL, readRawBody, setResponseHeaders, setResponseStatus, type EventHandler, type H3Event } from "h3";
import { BodyTooLarge, clientIp, errorResponse, matchRoute, parseQuery, parseRequestBody, requestIdOf, responseForRun, type ClientIpOptions, type ContextInput, type HttpResponse, type Kestrel } from "@michaelthielemann/kestrel";

export interface KestrelHandlerOptions extends ClientIpOptions {
  mountPath?: string;
  maxBodyBytes?: number;
  inlineTypes?: readonly string[];
}

export type KestrelRunner = Pick<Kestrel, "run" | "triggers">;

function stripMount(pathname: string, mountPath: string): string | null {
  if (mountPath === "" || mountPath === "/") return pathname;
  if (pathname === mountPath) return "/";
  return pathname.startsWith(mountPath + "/") ? pathname.slice(mountPath.length) : null;
}

const WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function respond(event: H3Event, response: HttpResponse): Promise<Buffer | string> {
  setResponseStatus(event, response.status);
  setResponseHeaders(event, response.headers);
  return typeof response.body === "string" ? response.body : Buffer.from(response.body);
}

export function createKestrelHandler(kestrel: KestrelRunner, options: KestrelHandlerOptions = {}): EventHandler {
  const mountPath = (options.mountPath ?? "").replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const peer: ClientIpOptions = { trustProxy: options.trustProxy ?? false, proxyHops: options.proxyHops ?? 1, ...(options.trustedHeader === undefined ? {} : { trustedHeader: options.trustedHeader }) };

  return eventHandler(async (event) => {
    const url = getRequestURL(event);
    const pathname = stripMount(url.pathname, mountPath);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(getRequestHeaders(event))) if (typeof v === "string") headers[k] = v;
    const requestId = requestIdOf(headers["x-request-id"]);

    const match = pathname === null ? undefined : matchRoute(kestrel.triggers.http, event.method, pathname);
    if (!match) return respond(event, errorResponse(404, `no route for ${event.method} ${url.pathname}`, requestId));

    let raw: Buffer | undefined;
    try {
      const body = WITH_BODY.has(event.method) ? await readRawBody(event, false) : undefined;
      raw = body === undefined ? undefined : Buffer.from(body);
      if (raw !== undefined && raw.byteLength > maxBodyBytes) throw new BodyTooLarge(`body exceeds ${maxBodyBytes} bytes`);
    } catch (err) {
      if (err instanceof BodyTooLarge) return respond(event, errorResponse(413, err.message, requestId));
      throw err;
    }
    let parsed;
    try {
      parsed = await parseRequestBody(headers["content-type"] ?? "", raw ?? new Uint8Array());
    } catch (err) {
      return respond(event, errorResponse(400, `invalid body: ${err instanceof Error ? err.message : String(err)}`, requestId));
    }

    const input: ContextInput = {
      trigger: { kind: "http", name: `${event.method} ${pathname ?? url.pathname}` },
      payload: { ...parseQuery(url.searchParams), ...parsed.payload },
      params: match.params,
      headers,
      files: parsed.files,
    };
    const ip = clientIp(event.node.req, peer);
    if (ip !== undefined) input.ip = ip;

    return respond(event, responseForRun(await kestrel.run(match.route.pipeline, input), options.inlineTypes));
  });
}
