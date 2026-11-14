import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { boundaryCast } from "../packages/core/src/cast.ts";
import { runUpgradeCli } from "../packages/upgrade/src/plugin.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures", "upgrade", "5.8.1");
const RELEASE_PROJECT = process.env.KESTREL_UPGRADE_RELEASE_PROJECT;

interface Manifest {
  version: string;
  password: { admin: string };
  media: Record<string, { id: string }>;
  pages: Record<string, string>;
  config: { images: { sizes: unknown[] } };
}

interface BootResult {
  version: string;
  login: number;
  getMedia: number;
  download: number;
  pages: { status: number; count: number };
}

const manifest = boundaryCast<Manifest>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");
const work: string[] = [];

afterAll(() => {
  for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOOT = `
const { readFileSync } = await import("node:fs");
const { boot } = await import("@michaelthielemann/kestrel");
const { loadConfig, loadModules, loadPipelines } = await import("@michaelthielemann/kestrel/load");
const setup = JSON.parse(readFileSync("boot-setup.json", "utf8"));
const root = process.cwd();
const config = await loadConfig(root + "/kestrel.config.ts");
config.triggers = config.triggers.filter((trigger) => trigger.event !== undefined);
delete config.http;
const images = config.modules.find((entry) => entry.use.includes("images-default"));
images.config = { ...images.config, sizes: setup.sizes };
const modules = await loadModules(root, config);
const pipelines = await loadPipelines(root, config.pipelinesDir ?? "./pipelines");
const silent = new Proxy({}, { get: () => () => {} });
const kestrel = await boot({ config, modules, pipelines, logger: silent, root });
await kestrel.start();
const trigger = { kind: "http", name: "fixture-boot" };
const call = (name, input, token) => kestrel.run(name, { trigger, ...input, headers: token ? { authorization: "Bearer " + token } : {} });
const login = await call("login", { body: { username: "admin", password: setup.password } });
const token = login.result?.token;
const media = await call("getMedia", { params: { id: setup.mediaId } }, token);
const download = await call("downloadMedia", { params: { id: setup.mediaId } }, token);
const pages = await call("listAllPages", {}, token);
await kestrel.stop();
const version = JSON.parse(readFileSync(root + "/node_modules/@michaelthielemann/kestrel/package.json", "utf8")).version;
process.stdout.write(JSON.stringify({ version, login: login.status, getMedia: media.status, download: download.status, pages: { status: pages.status, count: pages.result?.items?.length ?? -1 } }));
`;

function instanceOnCopy(project: string): { dir: string; db: string; blobs: string } {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-fixture-release-"));
  work.push(dir);
  for (const entry of readdirSync(project)) {
    if (entry === "node_modules" || entry === "data") continue;
    cpSync(join(project, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(project, "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "data"));
  copyFileSync(join(FIXTURE, "kestrel.db"), join(dir, "data", "kestrel.db"));
  cpSync(join(FIXTURE, "blobs"), join(dir, "data", "blobs"), { recursive: true });
  writeFileSync(join(dir, "boot-setup.json"), JSON.stringify({ sizes: manifest.config.images.sizes, password: manifest.password.admin, mediaId: manifest.media.logo!.id }));
  writeFileSync(join(dir, "boot-release.mjs"), BOOT);
  return { dir, db: join(dir, "data", "kestrel.db"), blobs: join(dir, "data", "blobs") };
}

function bootRelease(dir: string): BootResult {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "boot-release.mjs"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0) throw new Error(`the release did not boot on the copy (${String(run.status ?? run.signal)}): ${run.stderr}`);
  return boundaryCast<BootResult>(JSON.parse(run.stdout), "json");
}

function expectServing(result: BootResult): void {
  expect(result.version).toBe(manifest.version);
  expect(result.login).toBe(200);
  expect(result.getMedia).toBe(200);
  expect(result.download).toBe(200);
  expect(result.pages.status).toBe(200);
  expect(result.pages.count).toBe(Object.keys(manifest.pages).length);
}

describe.skipIf(RELEASE_PROJECT === undefined || !existsSync(join(RELEASE_PROJECT, "node_modules")))("the release the fixture comes from, on a copy of its data", () => {
  it("boots on an unchanged copy and serves its media and pages", () => {
    const copy = instanceOnCopy(RELEASE_PROJECT!);
    expectServing(bootRelease(copy.dir));
  });

  it("still boots on a copy that kestrel upgrade migrate --plan has read", async () => {
    const copy = instanceOnCopy(RELEASE_PROJECT!);
    const lines: string[] = [];
    const code = await runUpgradeCli(["migrate", "--root", join(ROOT, "examples", "minimal"), "--db", copy.db, "--blobs-dir", copy.blobs, "--plan"], { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) });
    expect(code, lines.join("\n")).toBe(1);
    expectServing(bootRelease(copy.dir));
  });
});
