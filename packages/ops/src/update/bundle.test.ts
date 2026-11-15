import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { writeBundle, type BundleInfo } from "../bundle.ts";
import { OpsError } from "../errors.ts";
import { runUpdate } from "./command.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const LINKED = { "kestrel-ops": "ops", "kestrel-target-cloudfoundry": "target-cloudfoundry", "kestrel-media-default": "media-default", "kestrel-images-default": "images-default", "kestrel-persistence-sqlite": "persistence-sqlite", "kestrel-sanitize-svg": "sanitize-svg" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(manifest = "deploy/manifest.yml"): string {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "kestrel-ops-update-bundle-"));
  dirs.push(base);
  const root = join(base, "project");
  const scope = join(root, "node_modules", "@michaelthielemann");
  mkdirSync(scope, { recursive: true });
  for (const [name, dir] of Object.entries(LINKED)) symlinkSync(join(REPO, "packages", dir), join(scope, name), "dir");
  const dependencies = Object.fromEntries(Object.keys(LINKED).map((name) => [`@michaelthielemann/${name}`, "*"]));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "example-site", private: true, dependencies }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, "deploy", "manifest.yml"), "applications:\n- name: site-api\n  env:\n    KESTREL_MIGRATIONS: check\n");
  const target = { adapter: "@michaelthielemann/kestrel-target-cloudfoundry", app: "site-api", org: "example-org", space: "prod", manifest };
  writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify({ environments: { prod: { target, storage: { bucket: "b" }, app: { replicaPrefix: "database/", mediaPrefix: "media/", deliveryPrefix: "www/" }, backups: { prefix: "kestrel-backups/" } } } }));
  return root;
}

const version = (dir: string): string => boundaryCast<{ version: string }>(JSON.parse(readFileSync(join(REPO, "packages", dir, "package.json"), "utf8")), "json").version;

describe("the update bundle", () => {
  it("carries the release's versions, the host facts, the target manifest and the module packages its storage migrations need", async () => {
    const root = project();
    let stdout = "";
    const host = { readyPath: "/ready", secretEnvNames: ["SESSION_SECRET"], localBootEnv: { SITE_MODE: "static" } };
    const code = await runUpdate(["bundle", "--json"], { cwd: root, host, stdout: (text) => (stdout += text), stderr: () => undefined });
    expect(code).toBe(0);
    const dir = join(root, ".kestrel-ops");
    expect(JSON.parse(stdout)).toMatchObject({ schema: "kestrel-ops/update-bundle@1", ok: true, dir });
    const info = boundaryCast<BundleInfo>(JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")), "json");
    expect(info.release.versions).toEqual(Object.fromEntries(Object.entries(LINKED).map(([name, pkg]) => [`@michaelthielemann/${name}`, version(pkg)]).sort(([a = ""], [b = ""]) => (a < b ? -1 : 1))));
    expect(info.release.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info).toMatchObject({ hostFacts: host, releaseRoot: "..", manifests: ["deploy/manifest.yml"], storagePackages: ["@michaelthielemann/kestrel-images-default", "@michaelthielemann/kestrel-media-default"] });
    expect(readFileSync(join(dir, "deploy", "manifest.yml"), "utf8")).toContain("KESTREL_MIGRATIONS: check");
    for (const name of ["kestrel-ops", "kestrel-target-cloudfoundry", "kestrel-media-default", "kestrel-images-default", "kestrel-persistence-sqlite", "kestrel-sanitize-svg", "kestrel", "kestrel-contracts"]) {
      expect(existsSync(join(dir, "node_modules", "@michaelthielemann", name, "package.json")), name).toBe(true);
    }
    expect(Object.keys(info.packages)).toEqual(expect.arrayContaining(["@michaelthielemann/kestrel-persistence-sqlite", "@michaelthielemann/kestrel-sanitize-svg"]));
  }, 120_000);

  it("refuses with exit 2 a target manifest outside the project or missing", () => {
    for (const manifest of ["../elsewhere.yml", "deploy/absent.yml"]) {
      const root = project(manifest);
      let error: unknown = null;
      try {
        writeBundle(root, root);
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof OpsError ? [error.exitCode, error.element] : error, manifest).toEqual([2, "prod.target.manifest"]);
    }
  }, 120_000);

  it("hands deploy, verify and update … to runUpdate and every other command to runOps, with the bundle's release and host facts", () => {
    const root = project();
    const { dir } = writeBundle(root, root, { readyPath: "/ready" }, () => 1);
    const stub = join(dirname(root), "stub.mjs");
    writeFileSync(stub, `const show = (fn) => async (argv, options) => { process.stdout.write(JSON.stringify({ fn, argv, releaseRoot: options.releaseRoot, host: options.host, versions: options.project.versions })); return 0; };\nexport const runOps = show("runOps");\nexport const runUpdate = show("runUpdate");\n`);
    const runner = join(dir, "run.mjs");
    writeFileSync(runner, readFileSync(runner, "utf8").replaceAll('"@michaelthielemann/kestrel-ops/run"', JSON.stringify(pathToFileURL(stub).href)));
    const call = (...argv: string[]): Record<string, unknown> => boundaryCast<Record<string, unknown>>(JSON.parse(execFileSync(process.execPath, [runner, ...argv], { encoding: "utf8" })), "json");
    expect(call("deploy", "--env", "prod")).toMatchObject({ fn: "runUpdate", argv: ["deploy", "--env", "prod"], releaseRoot: root, host: { readyPath: "/ready" } });
    expect(call("verify", "--env", "prod")).toMatchObject({ fn: "runUpdate", argv: ["verify", "--env", "prod"] });
    expect(call("update", "status", "--env", "prod")).toMatchObject({ fn: "runUpdate", argv: ["status", "--env", "prod"] });
    expect(call("update", "rollback", "--run", "abc123")).toMatchObject({ fn: "runUpdate", argv: ["rollback", "--run", "abc123"] });
    const ops = call("backup", "list");
    expect(ops).toMatchObject({ fn: "runOps", argv: ["backup", "list"] });
    expect(Reflect.get(Object(ops.versions), "@michaelthielemann/kestrel-media-default")).toBe(version("media-default"));
  }, 120_000);
});
