import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIPv6, type LookupFunction } from "node:net";

/**
 * Sends one request without following redirects. `addresses`, when present, are the IP addresses the checks
 * approved for the URL's host, in resolution order; the default fetcher connects to one of exactly those.
 */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect: "manual"; addresses?: string[] },
) => Promise<{ status: number; headers?: { get(name: string): string | null } }>;

/** Resolves a hostname to every address it has. */
export type Resolver = (hostname: string) => Promise<string[]>;

/** The system resolver (`dns.lookup`, all addresses). */
export const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * A `lookup` for `net.connect` that answers with the given addresses instead of resolving: all of them in
 * order when asked for all (so the connection can fall back from one to the next), else the first. It
 * answers on the next tick, as a real resolution does, so a connection that fails at once is reported
 * through the request rather than thrown.
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIPv6(address) ? 6 : 4 }));
  return (_hostname, options, callback) => {
    process.nextTick(() => {
      const [first] = entries;
      if (first === undefined) callback(Object.assign(new Error("no address to connect to"), { code: "ENOTFOUND" }), "", 0);
      else if (options.all) callback(null, entries);
      else callback(null, first.address, first.family);
    });
  };
}

/** The default fetcher: `node:http`/`node:https`, connecting to one of `init.addresses` when given and reading only the status line and headers. */
export const httpFetcher: Fetcher = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions & { autoSelectFamily?: boolean } = { method: init.method, headers: init.headers, signal: init.signal };
    if (init.addresses !== undefined) {
      options.lookup = pinnedLookup(init.addresses);
      options.autoSelectFamily = true;
    }
    const req = send(target, options, (res) => {
      const location = res.headers.location ?? null;
      resolve({ status: res.statusCode ?? 0, headers: { get: (name) => (name.toLowerCase() === "location" ? location : null) } });
      res.on("error", () => undefined);
      res.destroy();
    });
    req.on("error", reject);
    req.end();
  });
