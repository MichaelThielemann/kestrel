import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
// eslint-disable-next-line no-restricted-imports -- the deploy job runs the bundled Cloud Foundry target against the stub cf that target ships for its own tests
import { FakeCloudFoundry } from "../../../target-cloudfoundry/src/fakeCloudFoundry.fixture.ts";
import { writeBundle } from "../bundle.ts";
import { MemoryBucket } from "../memoryStore.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const BUCKET = "kestrel-test";
const LOCATION = "kestrel-backups/";
const APP = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };

const STRIP_TYPES = `import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }), shortCircuit: true };
  },
});
`;

const xml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

function answer(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

function s3Server(bucket: MemoryBucket): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const [, name = "", ...rest] = url.pathname.split("/");
      const key = rest.map(decodeURIComponent).join("/");
      const data = await body(request);
      if (name !== BUCKET) return answer(response, 404, "NoSuchBucket");
      const object = bucket.objects.get(key);
      const headers = (o: NonNullable<typeof object>) => ({ etag: `"${o.etag}"`, "content-length": String(o.data.byteLength), "last-modified": new Date(o.lastModified).toUTCString(), "content-type": o.contentType ?? "application/octet-stream" });
      if (key === "") {
        if (request.method === "HEAD") return response.writeHead(200).end();
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...bucket.objects].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
        const items = contents.map(([k, o]) => `<Contents><Key>${xml(k)}</Key><LastModified>${new Date(o.lastModified).toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.data.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("");
        response.writeHead(200, { "content-type": "application/xml" });
        return response.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      }
      switch (request.method) {
        case "GET":
        case "HEAD": {
          if (object === undefined) return request.method === "HEAD" ? response.writeHead(404).end() : answer(response, 404, "NoSuchKey");
          const ifMatch = request.headers["if-match"];
          if (typeof ifMatch === "string" && ifMatch.replaceAll('"', "") !== object.etag) return answer(response, 412, "PreconditionFailed");
          response.writeHead(200, headers(object));
          return response.end(request.method === "HEAD" ? undefined : Buffer.from(object.data));
        }
        case "PUT": {
          if (request.headers["if-none-match"] === "*" && object !== undefined) return answer(response, 412, "PreconditionFailed");
          const source = request.headers["x-amz-copy-source"];
          if (typeof source === "string") {
            const from = decodeURIComponent(source.replace(/^\//, "")).slice(BUCKET.length + 1);
            const copied = bucket.objects.get(from);
            if (copied === undefined) return answer(response, 404, "NoSuchKey");
            const condition = request.headers["x-amz-copy-source-if-match"];
            if (typeof condition === "string" && condition.replaceAll('"', "") !== copied.etag) return answer(response, 412, "PreconditionFailed");
            bucket.write(key, copied.data, "copy", copied.contentType);
            const written = bucket.objects.get(key);
            response.writeHead(200, { "content-type": "application/xml" });
            return response.end(`<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"${written?.etag ?? ""}"</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`);
          }
          const contentType = request.headers["content-type"];
          bucket.write(key, new Uint8Array(data), "put", typeof contentType === "string" ? contentType : undefined);
          response.writeHead(200, { etag: `"${bucket.objects.get(key)?.etag ?? ""}"` });
          return response.end();
        }
        case "DELETE":
          bucket.remove(key);
          return response.writeHead(204).end();
        default:
          return answer(response, 405, "MethodNotAllowed");
      }
    })().catch((cause: unknown) => answer(response, 500, cause instanceof Error ? cause.name : "InternalError"));
  });
}

interface Exited {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>, cwd: string): Promise<Exited> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
}

function parentsHoldNoModules(dir: string): boolean {
  for (let at = dirname(dir); ; at = dirname(at)) {
    if (existsSync(join(at, "node_modules"))) return false;
    if (dirname(at) === at) return true;
  }
}

let cf: FakeCloudFoundry;
let server: Server;
let bucket: MemoryBucket;
let base: string;

beforeEach(async () => {
  cf = new FakeCloudFoundry();
  await cf.listen();
  cf.addApp({ ...APP, env: { NODE_ENV: "production" } });
  bucket = new MemoryBucket(BUCKET);
  server = s3Server(bucket);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = mkdtempSync(join(realpathSync(tmpdir()), "kestrel-ops-clean-container-"));
});

afterEach(async () => {
  await cf.close();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(base, { recursive: true, force: true });
  rmSync(cf.bin, { recursive: true, force: true });
});

describe("a deploy job in a clean container", () => {
  it("runs the bundle with only node, the platform CLI and HOME: deploy opens its run in the backup location and update status shows it", async () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const project = join(base, "project");
    const scope = join(project, "node_modules", "@michaelthielemann");
    mkdirSync(scope, { recursive: true });
    for (const [name, dir] of Object.entries({ "kestrel-ops": "ops", "kestrel-target-cloudfoundry": "target-cloudfoundry" })) symlinkSync(join(REPO, "packages", dir), join(scope, name), "dir");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "example-site", private: true, dependencies: { "@michaelthielemann/kestrel-ops": "*", "@michaelthielemann/kestrel-target-cloudfoundry": "*" } }));
    writeFileSync(join(project, "manifest.yml"), "applications:\n- name: site-api\n");
    const secret = (value: string) => ({ command: ["node", "-e", `process.stdout.write(${JSON.stringify(value)})`] });
    const environment = {
      target: { adapter: "@michaelthielemann/kestrel-target-cloudfoundry", app: APP.name, org: "example-org", space: "dev", manifest: "manifest.yml" },
      storage: { bucket: BUCKET, endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: secret("clean-container-key"), secretAccessKey: secret("clean-container-secret") } },
      app: { replicaPrefix: "database/", mediaPrefix: "media/", deliveryPrefix: "www/" },
      backups: { prefix: LOCATION },
    };
    writeFileSync(join(project, "kestrel.environments.json"), JSON.stringify({ environments: { prod: environment } }));
    writeBundle(project, project, { readyPath: "/ready" });
    const artifact = join(base, "artifact");
    mkdirSync(artifact);
    cpSync(join(project, ".kestrel-ops"), join(artifact, ".kestrel-ops"), { recursive: true });
    cpSync(join(project, "manifest.yml"), join(artifact, "manifest.yml"));
    rmSync(project, { recursive: true, force: true });
    expect(parentsHoldNoModules(join(artifact, ".kestrel-ops"))).toBe(true);
    const hook = join(base, "strip-types.mjs");
    writeFileSync(hook, STRIP_TYPES);
    const home = join(base, "home");
    mkdirSync(home);
    const env = { PATH: [cf.bin, dirname(process.execPath)].join(delimiter), HOME: home, CF_STUB_URL: cf.url };
    const runner = join(artifact, ".kestrel-ops", "run.mjs");

    const deploy = await run(["--disable-warning=ExperimentalWarning", "--import", hook, runner, "deploy", "--env", "prod", "--json"], env, artifact);
    expect(deploy.stderr).not.toMatch(/ERR_|Cannot find|is not installed|cannot load/);
    const document = boundaryCast<Record<string, unknown>>(JSON.parse(deploy.stdout), "json");
    expect(document).toMatchObject({ schema: "kestrel-ops/update-deploy@1", exitCode: deploy.code });
    const runId = String(document.runId);
    const journal = [...bucket.objects.keys()].filter((key) => key.startsWith(`${LOCATION}runs/${runId}/`));
    expect(journal[0]).toBe(`${LOCATION}runs/${runId}/000001-run-started.json`);
    const opening = boundaryCast<{ data: Record<string, unknown> }>(JSON.parse(new TextDecoder().decode(bucket.objects.get(journal[0] ?? "")?.data)), "json");
    expect(opening.data).toMatchObject({ command: "update deploy", env: "prod", phase: "deploy" });
    const locks = [...bucket.objects.keys()].filter((key) => key.startsWith(`${LOCATION}locks/${runId}/`));
    expect(locks.some((key) => key.includes("-start-"))).toBe(true);
    expect(locks.some((key) => key.includes("-released-"))).toBe(true);
    expect(JSON.stringify([...bucket.objects.values()].map((o) => new TextDecoder().decode(o.data)))).not.toMatch(/clean-container-(key|secret)/);

    const status = await run(["--disable-warning=ExperimentalWarning", "--import", hook, runner, "update", "status", "--env", "prod", "--json"], env, artifact);
    expect(status.stderr).toBe("");
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ schema: "kestrel-ops/update-status@1", env: "prod", run: { runId, command: "update deploy" } });
    expect(readFileSync(join(artifact, ".kestrel-ops", "bundle.json"), "utf8")).toContain('"readyPath": "/ready"');
  }, 180_000);
});
