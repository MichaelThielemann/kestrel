import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "../packages/core/src/cast.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "release.mjs");

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });
}

let root: string;
let out: string;
let server: Server | undefined;
let published: Map<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kestrel-release-root-"));
  out = join(root, "artifacts");
  published = new Map();
  for (const [dir, name] of [["alpha", "@example/alpha"], ["beta", "@example/beta"]] as const) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name, version: "1.2.3", files: ["index.js"] }));
    writeFileSync(join(root, "packages", dir, "index.js"), `export const name = ${JSON.stringify(name)};\n`);
  }
  mkdirSync(join(root, "packages", "private-tool"), { recursive: true });
  writeFileSync(join(root, "packages", "private-tool", "package.json"), JSON.stringify({ name: "private-tool", version: "0.0.1", private: true }));
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  if (server !== undefined) await new Promise((done) => server?.close(done));
  server = undefined;
});

async function registry(): Promise<string> {
  server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? "").replace(/^\//, "");
    const integrity = published.get(path);
    if (integrity === undefined) {
      response.writeHead(404).end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ dist: { integrity } }));
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const address = boundaryCast<AddressInfo>(server.address(), "host");
  return `http://127.0.0.1:${address.port}`;
}

function planned(): { tag: string; packages: { name: string; version: string; file: string; integrity: string }[] } {
  return boundaryCast(JSON.parse(readFileSync(join(out, "release.json"), "utf8")), "json");
}

describe("release plan", () => {
  it("packs every publishable package that carries the tag version, with checksums", async () => {
    const result = await run(["plan", "--tag", "v1.2.3", "--root", root, "--dir", out]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const release = planned();
    expect(release.tag).toBe("v1.2.3");
    expect(release.packages.map((entry) => `${entry.name}@${entry.version}`)).toEqual(["@example/alpha@1.2.3", "@example/beta@1.2.3"]);
    expect(readFileSync(join(out, "SHA512SUMS"), "utf8")).toMatch(/^[0-9a-f]{128} {2}example-alpha-1\.2\.3\.tgz\n[0-9a-f]{128} {2}example-beta-1\.2\.3\.tgz\n$/);
  }, 60000);

  it("refuses a tag that does not match every publishable package version", async () => {
    const result = await run(["plan", "--tag", "v1.2.4", "--root", root, "--dir", out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("@example/alpha@1.2.3");
  });
});

describe("release publish", () => {
  it("publishes every package whose version is not on the registry yet", async () => {
    await run(["plan", "--tag", "v1.2.3", "--root", root, "--dir", out]);
    const result = await run(["publish", "--tag", "v1.2.3", "--dir", out, "--dry-run"], { KESTREL_RELEASE_REGISTRY: await registry() });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("publish @example/alpha@1.2.3\npublish @example/beta@1.2.3\n");
  }, 60000);

  it("fails before publishing anything when a later package of this release is already on the registry with other content", async () => {
    await run(["plan", "--tag", "v1.2.3", "--root", root, "--dir", out]);
    published.set("@example/beta/1.2.3", "sha512-somethingelse");
    const result = await run(["publish", "--tag", "v1.2.3", "--dir", out, "--dry-run"], { KESTREL_RELEASE_REGISTRY: await registry() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already on the registry with different content: @example/beta@1.2.3; nothing of this release is published");
    expect(result.stdout).toBe("");
  }, 60000);

  it("treats a version already published from this very artifact as done, so a failed publish can be re-run", async () => {
    await run(["plan", "--tag", "v1.2.3", "--root", root, "--dir", out]);
    const alpha = planned().packages.find((entry) => entry.name === "@example/alpha");
    published.set("@example/alpha/1.2.3", alpha?.integrity ?? "");
    const result = await run(["publish", "--tag", "v1.2.3", "--dir", out, "--dry-run"], { KESTREL_RELEASE_REGISTRY: await registry() });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("done    @example/alpha@1.2.3 (this artifact is already on the registry)\npublish @example/beta@1.2.3\n");
  }, 60000);

  it("refuses artifacts that do not match their checksums or were built for another tag", async () => {
    await run(["plan", "--tag", "v1.2.3", "--root", root, "--dir", out]);
    const url = await registry();
    const otherTag = await run(["publish", "--tag", "v1.2.4", "--dir", out, "--dry-run"], { KESTREL_RELEASE_REGISTRY: url });
    expect(otherTag.code).toBe(1);
    expect(otherTag.stderr).toContain("built for v1.2.3");
    writeFileSync(join(out, "example-beta-1.2.3.tgz"), "not the packed file");
    const tampered = await run(["publish", "--tag", "v1.2.3", "--dir", out, "--dry-run"], { KESTREL_RELEASE_REGISTRY: url });
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain("example-beta-1.2.3.tgz does not match its recorded checksum");
  }, 60000);
});
