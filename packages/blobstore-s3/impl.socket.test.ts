import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createBlobstoreS3, type BlobstoreS3, type Config } from "./impl.ts";

const TIMEOUT_MS = 400;

const opened: Array<{ close(): void }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

function portOf(server: NetServer | HttpServer): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return address.port;
}

async function listen<T extends NetServer | HttpServer>(server: T): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function storeAt(port: number, extra: Partial<Config> = {}): BlobstoreS3 {
  const store = createBlobstoreS3({
    bucket: "b",
    prefix: "",
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    accessKeyId: "test",
    secretAccessKey: "test",
    timeoutMs: TIMEOUT_MS,
    maxAttempts: 1,
    ...extra,
  });
  opened.push(store);
  return store;
}

async function silentSocket(): Promise<{ port: number; connections: () => number }> {
  const sockets: Socket[] = [];
  const server = await listen(createNetServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.resume();
  }));
  opened.push({
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  });
  return { port: portOf(server), connections: () => sockets.length };
}

async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = await listen(createHttpServer(handler));
  opened.push({
    close() {
      server.closeAllConnections();
      server.close();
    },
  });
  return portOf(server);
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

describe("blobstore/s3 against a socket that accepts and never answers", () => {
  it("put answers TRANSIENT within about twice timeoutMs", async () => {
    const silent = await silentSocket();
    const store = storeAt(silent.port);
    const { value, ms } = await timed(() => store.put("a.bin", new Uint8Array(64)));
    expectErr(value, "TRANSIENT");
    expect(ms).toBeLessThan(TIMEOUT_MS * 2);
    expect(silent.connections()).toBe(1);
  }, 5000);

  it("get and list answer TRANSIENT within about twice timeoutMs", async () => {
    const silent = await silentSocket();
    const store = storeAt(silent.port);
    const got = await timed(() => store.get("a.bin"));
    expectErr(got.value, "TRANSIENT");
    expect(got.ms).toBeLessThan(TIMEOUT_MS * 2);
    const listed = await timed(() => store.list(""));
    expectErr(listed.value, "TRANSIENT");
    expect(listed.ms).toBeLessThan(TIMEOUT_MS * 2);
  }, 5000);

  it("tries again on a fresh connection up to maxAttempts before it answers TRANSIENT", async () => {
    const silent = await silentSocket();
    const store = storeAt(silent.port, { maxAttempts: 2 });
    expectErr(await store.put("a.bin", new Uint8Array(64)), "TRANSIENT");
    expect(silent.connections()).toBe(2);
  }, 10000);
});

describe("blobstore/s3 timeoutMs is an idle limit, not a limit on the whole request", () => {
  it("completes an upload that keeps moving for much longer than timeoutMs", async () => {
    const slowBytes = 8 * 1024 * 1024;
    const pauseEvery = 512 * 1024;
    let received = 0;
    const port = await httpServer((req, res) => {
      req.on("data", (chunk: Buffer) => {
        const before = received;
        received += chunk.byteLength;
        if (received <= slowBytes && Math.floor(received / pauseEvery) > Math.floor(before / pauseEvery)) {
          req.pause();
          setTimeout(() => req.resume(), 100);
        }
      });
      req.on("end", () => {
        res.writeHead(200, { ETag: "\"0\"" });
        res.end();
      });
    });
    const body = new Uint8Array(32 * 1024 * 1024);
    const { value, ms } = await timed(() => storeAt(port).put("large.bin", body));
    expectOk(value);
    expect(received).toBe(body.byteLength);
    expect(ms).toBeGreaterThan(TIMEOUT_MS * 2);
  }, 20000);

  it("completes a download whose body arrives in pieces for much longer than timeoutMs", async () => {
    const pieces = 10;
    const port = await httpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(1024, sent));
        sent += 1;
        if (sent === pieces) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on("close", () => clearInterval(timer));
    });
    const { value, ms } = await timed(() => storeAt(port).get("slow.bin"));
    expect(expectOk(value)?.byteLength).toBe(pieces * 1024);
    expect(ms).toBeGreaterThan(TIMEOUT_MS * 2);
  }, 10000);
});
