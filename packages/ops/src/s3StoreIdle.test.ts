import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { s3Store, type S3Store } from "./s3Store.ts";

const IDLE_MS = 300;

const servers: Array<Server | HttpServer> = [];
const sockets: Socket[] = [];
const stores: S3Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
});

async function listening(server: Server | HttpServer): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

function storeAt(endpoint: string): S3Store {
  const store = s3Store({ bucket: "silent", prefix: "", region: "us-east-1", endpoint, forcePathStyle: true, accessKeyId: "key", secretAccessKey: "secret", timeoutMs: IDLE_MS });
  stores.push(store);
  return store;
}

async function settlesWithin<T>(ms: number, promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe("the S3 store against a store that stops answering", { timeout: 60_000 }, () => {
  it("fails a read, a write and a listing whose connection accepts but never answers, instead of waiting forever", async () => {
    const silent = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => undefined);
    });
    const store = storeAt(await listening(silent));
    const calls: Array<[string, () => Promise<unknown>]> = [["get", () => store.get("a")], ["put", () => store.put("a", new Uint8Array([1, 2, 3]))], ["list", () => store.list("")]];
    for (const [what, call] of calls) {
      const settled = await settlesWithin(15_000, call());
      expect(settled.ok, what).toBe(false);
    }
  });

  it("reads an object that arrives in pieces for longer than the idle timeout, without a warning", async () => {
    const body = "x".repeat(10);
    const warn = vi.spyOn(console, "warn");
    const slow = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length), etag: '"e"' });
      let sent = 0;
      const timer = setInterval(() => {
        response.write(body[sent] ?? "");
        sent += 1;
        if (sent >= body.length) {
          clearInterval(timer);
          response.end();
        }
      }, IDLE_MS / 3);
    });
    const store = storeAt(await listening(slow));
    const settled = await settlesWithin(15_000, store.get("a"));
    expect(settled).toEqual({ ok: true, value: new TextEncoder().encode(body) });
    expect(warn.mock.calls.flat().join("\n")).not.toContain("requestTimeout");
  });
});
