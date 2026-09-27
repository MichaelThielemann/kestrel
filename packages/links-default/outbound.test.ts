import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ok } from "@michaelthielemann/kestrel/result";
import { checkable, createLinksDefault, httpFetcher, isPrivateAddress, type Fetcher, type Resolver } from "./impl.ts";
import { pinnedLookup } from "./outbound.ts";

const model: ContentModel = { types: { pages: { kind: "multi", fields: { body: "json" } } } };

function contentWith(urls: string[]): { content: Content; id: string } {
  const id = randomUUID();
  const doc = boundaryCast<ContentDocument>({ id, createdAt: 1, updatedAt: 1, body: urls }, "host");
  const notImplemented = () => Promise.reject(new Error("not needed"));
  const content: Content = {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    get: async () => ok(doc),
    list: async () => ok({ items: [doc], total: 1 }),
    create: notImplemented,
    set: notImplemented,
    update: notImplemented,
    remove: notImplemented,
    removeTranslation: notImplemented,
  };
  return { content, id };
}

const config = { timeoutMs: 2000, concurrency: 1, recheckAfterSeconds: 3600, userAgent: "test", allowPrivate: false, maxLinksPerDocument: 1000, checkBudgetSeconds: 3600 };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listener(handle: (url: string, host: string | undefined) => { status: number; location?: string }): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const answer = handle(req.url ?? "", req.headers.host);
    res.writeHead(answer.status, answer.location ? { location: answer.location } : {});
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("listener has no port");
  return { port: address.port, requests };
}

function recordingFetcher(answers: Record<string, { status: number; location?: string }>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(`${init.method} ${url} via ${init.addresses?.join(",") ?? "-"}`);
    const answer = answers[url];
    if (!answer) throw new Error("unexpected request");
    return { status: answer.status, headers: { get: (name: string) => (name.toLowerCase() === "location" ? (answer.location ?? null) : null) } };
  };
  return Object.assign(fetcher, { calls });
}

const resolver = (table: Record<string, string[]>): Resolver => async (hostname) => {
  const addresses = table[hostname];
  if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
  return addresses;
};

describe("outbound link checks", () => {
  it("never requests localhost written with a trailing dot and reports it as a private address", async () => {
    const target = await listener(() => ({ status: 200 }));
    const url = `http://localhost.:${target.port}/page`;
    const { content, id } = contentWith([url]);
    const db = createFakePersistence();
    const links = await createLinksDefault(config, content, db);
    expectOk(await links.extract("pages", id));
    expectOk(await links.check());
    expect(target.requests).toEqual([]);
    expect(expectOk(await links.report()).map((r) => [r.url, r.error])).toEqual([[url, "private address"]]);
  });

  it("does not follow a redirect to a loopback address", async () => {
    const target = await listener(() => ({ status: 200 }));
    const start = "https://moved.example/old";
    const fetcher = recordingFetcher({ [start]: { status: 302, location: `http://127.0.0.1:${target.port}/after` } });
    const { content, id } = contentWith([start]);
    const links = await createLinksDefault(config, content, createFakePersistence(), fetcher, Date.now, resolver({ "moved.example": ["93.184.215.14"] }));
    expectOk(await links.extract("pages", id));
    expectOk(await links.check());
    expect(fetcher.calls).toEqual(["HEAD https://moved.example/old via 93.184.215.14"]);
    expect(target.requests).toEqual([]);
    expect(expectOk(await links.report()).map((r) => [r.url, r.error])).toEqual([[start, "private address"]]);
  });

  it("follows a redirect to a public address and reports the final status", async () => {
    const start = "https://moved.example/old";
    const next = "https://moved.example/new";
    const fetcher = recordingFetcher({ [start]: { status: 301, location: "/new" }, [next]: { status: 404 } });
    const { content, id } = contentWith([start]);
    const links = await createLinksDefault(config, content, createFakePersistence(), fetcher, Date.now, resolver({ "moved.example": ["93.184.215.14"] }));
    expectOk(await links.extract("pages", id));
    expectOk(await links.check());
    expect(fetcher.calls).toEqual(["HEAD https://moved.example/old via 93.184.215.14", "HEAD https://moved.example/new via 93.184.215.14"]);
    expect(expectOk(await links.report()).map((r) => [r.url, r.status, r.error])).toEqual([[start, 404, null]]);
  });

  it("stops after too many redirects", async () => {
    const answers: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i < 20; i++) answers[`https://loop.example/${i}`] = { status: 302, location: `/${i + 1}` };
    const fetcher = recordingFetcher(answers);
    const { content, id } = contentWith(["https://loop.example/0"]);
    const links = await createLinksDefault(config, content, createFakePersistence(), fetcher, Date.now, resolver({ "loop.example": ["93.184.215.14"] }));
    expectOk(await links.extract("pages", id));
    expectOk(await links.check());
    expect(fetcher.calls.length).toBe(6);
    expect(expectOk(await links.report()).map((r) => r.error)).toEqual(["too many redirects"]);
  });

  it("blocks a hostname whose resolution includes a private address", async () => {
    const fetcher = recordingFetcher({});
    const urls = ["https://inside.example/a", "https://mixed.example/b"];
    const { content, id } = contentWith(urls);
    const links = await createLinksDefault(config, content, createFakePersistence(), fetcher, Date.now, resolver({ "inside.example": ["127.0.0.1"], "mixed.example": ["93.184.215.14", "10.0.0.8"] }));
    expectOk(await links.extract("pages", id));
    expectOk(await links.check());
    expect(fetcher.calls).toEqual([]);
    expect(expectOk(await links.report()).map((r) => [r.url, r.error]).sort()).toEqual([
      ["https://inside.example/a", "private address"],
      ["https://mixed.example/b", "private address"],
    ]);
  });

  it("refuses reserved, shared, benchmarking, multicast, broadcast, mapped and translated addresses", () => {
    for (const url of ["http://100.64.0.1/", "http://198.18.0.1/", "http://224.0.0.1/", "http://255.255.255.255/", "http://[::ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://[fec0::1]/", "http://[ff02::1]/", "http://localhost./", "http://LOCALHOST/", "http://192.0.2.1/", "http://240.0.0.1/", "http://[2001:db8::1]/", "http://[::]/"]) {
      expect(checkable(url, false), url).toBe("private address");
    }
    for (const address of ["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "64:ff9b::808:808"]) expect(isPrivateAddress(address), address).toBe(false);
    for (const address of ["127.0.0.1", "::1", "::ffff:10.0.0.1", "2002:7f00:1::", "fe80::1", "fd12::1", "0.1.2.3", "169.254.169.254"]) expect(isPrivateAddress(address), address).toBe(true);
  });

  it("connects the default fetcher to the checked address, not to a fresh resolution", async () => {
    const hosts: Array<string | undefined> = [];
    const target = await listener((_url, host) => {
      hosts.push(host);
      return { status: 204 };
    });
    const res = await httpFetcher(`http://pinned.invalid:${target.port}/x`, { method: "HEAD", headers: { "user-agent": "test" }, signal: new AbortController().signal, redirect: "manual", addresses: ["127.0.0.1"] });
    expect(res.status).toBe(204);
    expect(hosts).toEqual([`pinned.invalid:${target.port}`]);
    expect(target.requests).toEqual(["HEAD /x"]);
  });

  it("hands every checked address of a hostname to the fetcher", async () => {
    const fetcher = recordingFetcher({ "https://dual.example/": { status: 200 } });
    const { content, id } = contentWith(["https://dual.example/"]);
    const links = await createLinksDefault(config, content, createFakePersistence(), fetcher, Date.now, resolver({ "dual.example": ["2606:4700:4700::1111", "93.184.215.14"] }));
    expectOk(await links.extract("pages", id));
    expectOk(await links.check());
    expect(fetcher.calls).toEqual(["HEAD https://dual.example/ via 2606:4700:4700::1111,93.184.215.14"]);
  });

  it("answers the pinned lookup asynchronously with every checked address in order", async () => {
    const lookup = pinnedLookup(["2001:4860::1", "93.184.215.14"]);
    let answered = false;
    const all = new Promise<unknown>((resolve) => {
      lookup("pinned.invalid", { all: true }, (_error, addresses) => {
        answered = true;
        resolve(addresses);
      });
    });
    expect(answered).toBe(false);
    expect(await all).toEqual([
      { address: "2001:4860::1", family: 6 },
      { address: "93.184.215.14", family: 4 },
    ]);
    const single = await new Promise<unknown[]>((resolve) => lookup("pinned.invalid", {}, (_error, address, family) => resolve([address, family])));
    expect(single).toEqual(["2001:4860::1", 6]);
  });

  it("falls back to the next checked address when the first cannot be reached", async () => {
    const target = await listener(() => ({ status: 204 }));
    const res = await httpFetcher(`http://pinned.invalid:${target.port}/x`, { method: "HEAD", headers: {}, signal: new AbortController().signal, redirect: "manual", addresses: ["::1", "127.0.0.1"] });
    expect(res.status).toBe(204);
    expect(target.requests).toEqual(["HEAD /x"]);
  });

  it("rejects a pinned connection that fails without raising an uncaught exception", async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", record);
    try {
      const closed = await listener(() => ({ status: 200 }));
      await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
      const outcome = await httpFetcher(`http://pinned.invalid:${closed.port}/x`, { method: "HEAD", headers: {}, signal: new AbortController().signal, redirect: "manual", addresses: ["127.0.0.1"] }).then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? "rejected" : "odd"),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(outcome).toBe("rejected");
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
