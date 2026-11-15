import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isErr } from "@michaelthielemann/kestrel/result";
import { OpsError } from "../errors.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { releasePackageDir, releaseStorages, releaseSvgSanitizer } from "./storages.ts";
import type { UpdateContext } from "./types.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

function fakePackage(h: UpdateHarness, name: string, files: Record<string, string>, exports: Record<string, string>): void {
  const dir = join(h.releaseDir, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "6.0.0", type: "module", exports }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
}

async function contextWith(h: UpdateHarness, versions: Record<string, string>): Promise<UpdateContext> {
  const ctx = await h.context();
  return { ...ctx, release: { ...ctx.release, versions } };
}

describe("the storages of the release", () => {
  it("builds the storage of every installed module package that exports one, in dependency order, the media one with the environment's media prefix", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const scope = join(h.releaseDir, "node_modules", "@michaelthielemann");
    mkdirSync(scope, { recursive: true });
    symlinkSync(join(REPO, "packages", "images-default"), join(scope, "kestrel-images-default"), "dir");
    symlinkSync(join(REPO, "packages", "media-default"), join(scope, "kestrel-media-default"), "dir");
    fakePackage(h, "@michaelthielemann/kestrel-plain", { "index.mjs": "export {};\n" }, { ".": "./index.mjs" });
    const ctx = await contextWith(h, { "@michaelthielemann/kestrel-images-default": "6.0.0", "@michaelthielemann/kestrel-media-default": "6.0.0", "@michaelthielemann/kestrel-plain": "6.0.0", "@michaelthielemann/kestrel-absent": "6.0.0" });
    const storages = await releaseStorages(ctx);
    expect(storages.map((s) => s.module)).toEqual(["media/default", "images/default"]);
    expect(storages[0]?.migrations.map((m) => m.id)).toContain("media-default:id-key-layout");
    expect(releasePackageDir(ctx, "@michaelthielemann/kestrel-absent")).toBeNull();
  });

  it("refuses with exit 2 a storage export that holds no storage()", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    fakePackage(h, "@michaelthielemann/kestrel-broken", { "storage.mjs": "export const other = 1;\n" }, { "./storage": "./storage.mjs" });
    const error = await releaseStorages(await contextWith(h, { "@michaelthielemann/kestrel-broken": "6.0.0" })).catch((caught: unknown) => caught);
    expect(error instanceof OpsError ? [error.exitCode, error.message] : error).toEqual([2, expect.stringContaining("exports no storage()")]);
  });

  it("cleans an SVG with the release's sanitize package and has no sanitizer without it", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    const ctx = await contextWith(h, {});
    expect(await releaseSvgSanitizer(ctx)).toBeNull();
    const scope = join(h.releaseDir, "node_modules", "@michaelthielemann");
    mkdirSync(scope, { recursive: true });
    symlinkSync(join(REPO, "packages", "sanitize-svg"), join(scope, "kestrel-sanitize-svg"), "dir");
    const sanitize = await releaseSvgSanitizer(ctx);
    const cleaned = await sanitize?.({ filename: "mark.svg", contentType: "image/svg+xml", data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>') });
    if (cleaned === undefined || isErr(cleaned)) throw new Error("the sanitizer refused a valid SVG");
    const text = new TextDecoder().decode(cleaned.value);
    expect(text).toContain("<rect");
    expect(text).not.toContain("script");
    const refused = await sanitize?.({ filename: "page.svg", contentType: "image/svg+xml", data: new TextEncoder().encode("<html><body>no svg</body></html>") });
    expect(refused !== undefined && isErr(refused)).toBe(true);
    rmSync(join(scope, "kestrel-sanitize-svg"));
  });
});
