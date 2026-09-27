import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, toNodeListener, toWebHandler } from "h3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, ok, silentLogger, type Context, type Kestrel } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createKestrelHandler } from "./index.ts";

const LIMIT = 256 * 1024;
const CHUNK = 16 * 1024;
const SLACK = 256 * 1024;

interface Served {
  base: string;
  bytesRead: () => number;
  runs: () => number;
  close: () => Promise<void>;
}

function watch(server: Server): () => number {
  let bytes = 0;
  server.prependListener("request", (req) => {
    const socket = req.socket;
    const record = () => {
      bytes = Math.max(bytes, socket.bytesRead);
    };
    req.once("close", record);
    socket.once("close", record);
  });
  return () => bytes;
}

const PARTS = { maxParts: 5, maxFiles: 3, maxFields: 4 };

async function bootProbe(http: { port: number; maxBodyBytes: number } | null): Promise<{ kestrel: Kestrel; runs: () => number }> {
  let runs = 0;
  const probe = defineModule({
    name: "probe/count",
    provides: [],
    requires: [],
    configSchema: z.object({}),
    async setup() { return {}; },
    steps: () => ({
      count: async (ctx: Context) => { runs += 1; return ok({ ...ctx, result: { ok: true } }); },
      files: async (ctx: Context) => { runs += 1; return ok({ ...ctx, result: { files: ctx.files.length, fields: Object.keys(ctx.body).length } }); },
    }),
    describe: () => ({
      count: { summary: "Counts the runs.", reads: [], writes: ["result"], output: { type: "object" } },
      files: { summary: "Counts the runs and the uploaded files.", reads: ["files", "body"], writes: ["result"], output: { type: "object" } },
    }),
  });
  const kestrel = await boot({
    config: {
      modules: [{ use: "./probe", config: {} }],
      triggers: [{ http: "POST /upload", pipeline: "upload" }, { http: "POST /files", pipeline: "files" }],
      http: http === null ? null : { ...http, multipart: PARTS },
    },
    modules: [probe],
    pipelines: [definePipeline({ name: "upload", steps: ["probe.count"] }), definePipeline({ name: "files", steps: ["probe.files"] })],
    logger: silentLogger,
  });
  return { kestrel, runs: () => runs };
}

async function coreServer(): Promise<Served> {
  const { kestrel, runs } = await bootProbe({ port: 0, maxBodyBytes: LIMIT });
  const port = (await kestrel.start()).http?.port ?? 0;
  return { base: `http://127.0.0.1:${port}`, bytesRead: () => 0, runs, close: async () => { await kestrel.stop({ timeoutMs: 100 }); } };
}

async function h3Adapter(): Promise<Served> {
  const { kestrel, runs } = await bootProbe(null);
  const app = createApp();
  app.use(createKestrelHandler(kestrel, { maxBodyBytes: LIMIT, multipart: PARTS }));
  const server = createServer(toNodeListener(app));
  const bytesRead = watch(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    await kestrel.stop({ timeoutMs: 100 });
  };
  return { base: `http://127.0.0.1:${boundaryCast<AddressInfo>(server.address(), "host").port}`, bytesRead, runs, close };
}

function form(files: number, fields: number): FormData {
  const data = new FormData();
  for (let i = 0; i < files; i++) data.append("file", new Blob([`f${i}`], { type: "text/plain" }), `f${i}.txt`);
  for (let i = 0; i < fields; i++) data.append(`field${i}`, `v${i}`);
  return data;
}

interface Upload {
  contentLength?: number;
  send: number;
}

function upload(base: string, { contentLength, send }: Upload): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    const req = request(`${base}/upload`, { method: "POST", headers });
    let answered = false;
    req.on("response", (res) => {
      answered = true;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", (err) => {
      if (!answered) reject(err);
    });
    let sent = 0;
    const chunk = Buffer.alloc(CHUNK, 0x20);
    const pump = () => {
      while (!answered && sent < send) {
        sent += CHUNK;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      if (!answered && contentLength === undefined) req.end();
    };
    req.flushHeaders();
    pump();
  });
}

describe.each([
  ["core server", coreServer],
  ["h3 adapter", h3Adapter],
])("request body limit: %s", (_name, start) => {
  let served: Served | undefined;
  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it("answers 413 to a Content-Length over the limit without reading the body", async () => {
    served = await start();
    const answer = await upload(served.base, { contentLength: 64 * 1024 * 1024, send: 0 });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(served.runs()).toBe(0);
  });

  it("answers 413 to a chunked body over the limit without running the pipeline", async () => {
    served = await start();
    const answer = await upload(served.base, { send: 16 * 1024 * 1024 });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(served.runs()).toBe(0);
  });

  it("accepts a body of exactly the limit", async () => {
    served = await start();
    const answer = await upload(served.base, { contentLength: LIMIT, send: LIMIT });
    expect(answer.status).toBe(200);
    expect(served.runs()).toBe(1);
  });
});

describe.each([
  ["core server", coreServer],
  ["h3 adapter", h3Adapter],
])("multipart limits: %s", (_name, start) => {
  let served: Served | undefined;
  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it("accepts files and fields up to the limits", async () => {
    served = await start();
    const answer = await fetch(`${served.base}/files`, { method: "POST", body: form(3, 2) });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ files: 3, fields: 2 });
  });

  it("answers 413 past maxFiles, maxFields or maxParts without running the pipeline", async () => {
    served = await start();
    for (const body of [form(4, 0), form(0, 5), form(3, 3)]) {
      const answer = await fetch(`${served.base}/files`, { method: "POST", body });
      expect(answer.status).toBe(413);
      expect(await answer.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    }
    expect(served.runs()).toBe(0);
  });

  it("stops at the first part past the limit instead of parsing the rest", async () => {
    served = await start();
    const boundary = "limit-boundary";
    const part = (i: number) => `--${boundary}\r\ncontent-disposition: form-data; name="field${i}"\r\n\r\nv${i}\r\n`;
    const body = [0, 1, 2, 3, 4].map(part).join("") + `--${boundary}\r\nnot a part header` + "x".repeat(1024);
    const answer = await fetch(`${served.base}/files`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
    expect(answer.status).toBe(413);
  });

  it("refuses a multipart body for a pipeline that reads no files, before reading it", async () => {
    served = await start();
    const answer = await fetch(`${served.base}/upload`, { method: "POST", body: form(1, 1) });
    expect(answer.status).toBe(415);
    expect(await answer.json()).toMatchObject({ code: "UNSUPPORTED" });
    expect(served.runs()).toBe(0);
    const json = await fetch(`${served.base}/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(200);
  });
});

describe("h3 adapter body reading", () => {
  it("stops reading a chunked body within one chunk past the limit", async () => {
    const served = await h3Adapter();
    try {
      expect((await upload(served.base, { send: 16 * 1024 * 1024 })).status).toBe(413);
    } finally {
      await served.close();
    }
    expect(served.bytesRead()).toBeGreaterThan(0);
    expect(served.bytesRead()).toBeLessThanOrEqual(LIMIT + CHUNK + SLACK);
  });
});

describe("h3 adapter with a body the host already holds", () => {
  it("applies the same limit to a web request body", async () => {
    const { kestrel, runs } = await bootProbe(null);
    try {
      const app = createApp();
      app.use(createKestrelHandler(kestrel, { maxBodyBytes: LIMIT }));
      const handle = toWebHandler(app);
      const post = (size: number) => handle(new Request("http://localhost/upload", { method: "POST", headers: { "content-type": "application/json" }, body: " ".repeat(size) }));
      expect((await post(LIMIT)).status).toBe(200);
      const over = await post(LIMIT + 1);
      expect(over.status).toBe(413);
      expect(await over.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
      expect(runs()).toBe(1);
    } finally {
      await kestrel.stop({ timeoutMs: 100 });
    }
  });
});
