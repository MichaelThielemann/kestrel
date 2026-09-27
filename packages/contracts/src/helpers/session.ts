import type { Trigger } from "@michaelthielemann/kestrel/context";

/** The name of the cookie an authn module sets on login and reads back as the session token. */
export const SESSION_COOKIE = "kestrel_token";

/** How the session cookie is written: its lifetime and whether it is marked `Secure`. */
export interface SessionCookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

/** A session token found on a request, and whether it came from the `Authorization` header or the session cookie. */
export interface RequestToken {
  token: string;
  source: "bearer" | "cookie";
}

const BEARER = /^bearer /i;

/** The session token of a request: a bearer token wins over the session cookie; `undefined` when there is neither. */
export function requestToken(headers: Record<string, string>): RequestToken | undefined {
  const auth = headers.authorization;
  if (auth && BEARER.test(auth)) return { token: auth.slice(7).trim(), source: "bearer" };
  for (const pair of (headers.cookie ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const raw = pair.slice(eq + 1).trim();
    if (raw === "") continue;
    try {
      return { token: decodeURIComponent(raw), source: "cookie" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function attributes(maxAgeSeconds: number, secure: boolean): string {
  return `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict`;
}

/** The `set-cookie` value that hands a session token to a browser: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` unless turned off. */
export function sessionCookie(token: string, options: SessionCookieOptions): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attributes(options.maxAgeSeconds, options.secure)}`;
}

/** The `set-cookie` value that removes the session cookie from a browser. */
export function clearedSessionCookie(options: Pick<SessionCookieOptions, "secure">): string {
  return `${SESSION_COOKIE}=; ${attributes(0, options.secure)}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Why a request authenticated by the session cookie may not act, or `undefined` when it may. Only an
 * HTTP request with an unsafe method is checked: it must come from the same origin, shown by
 * `Sec-Fetch-Site: same-origin` or, from a browser that does not send that header, by an `Origin` whose
 * host is the request's `Host` (or `X-Forwarded-Host`). A request carrying neither is refused.
 */
export function crossOriginRefusal(trigger: Trigger, headers: Record<string, string>): string | undefined {
  if (trigger.kind !== "http") return undefined;
  const method = trigger.name.split(" ")[0]?.toUpperCase() ?? "";
  if (SAFE_METHODS.has(method)) return undefined;
  const site = headers["sec-fetch-site"]?.trim().toLowerCase();
  if (site !== undefined && site !== "") return site === "same-origin" ? undefined : `a ${method} authenticated by the session cookie must come from the same origin (sec-fetch-site: ${site})`;
  const origin = headers.origin;
  if (origin === undefined || origin === "") return `a ${method} authenticated by the session cookie needs a same-origin Origin or Sec-Fetch-Site header, or a bearer token`;
  const host = originHost(origin);
  const candidates = [headers.host, headers["x-forwarded-host"]?.split(",")[0]].filter((h): h is string => h !== undefined && h !== "").map((h) => h.trim().toLowerCase());
  return host !== undefined && candidates.includes(host) ? undefined : `a ${method} authenticated by the session cookie must come from the same origin (origin: ${origin})`;
}
