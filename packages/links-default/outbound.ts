import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv6, type LookupFunction } from "node:net";

/**
 * Sends one request without following redirects. `address`, when present, is the IP address the checks
 * approved for the URL's host; the default fetcher connects to exactly that address.
 */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect: "manual"; address?: string },
) => Promise<{ status: number; headers?: { get(name: string): string | null } }>;

/** Resolves a hostname to every address it has. */
export type Resolver = (hostname: string) => Promise<string[]>;

/** The system resolver (`dns.lookup`, all addresses). */
export const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function pinnedLookup(address: string): LookupFunction {
  const family = isIPv6(address) ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** The default fetcher: `node:http`/`node:https`, connecting to `init.address` when given and reading only the status line and headers. */
export const httpFetcher: Fetcher = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = { method: init.method, headers: init.headers, signal: init.signal };
    if (init.address !== undefined) options.lookup = pinnedLookup(init.address);
    const req = send(target, options, (res) => {
      const location = res.headers.location ?? null;
      resolve({ status: res.statusCode ?? 0, headers: { get: (name) => (name.toLowerCase() === "location" ? location : null) } });
      res.on("error", () => undefined);
      res.destroy();
    });
    req.on("error", reject);
    req.end();
  });
