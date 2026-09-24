import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedVersions } from "./versions.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-versions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function installFakePackage(root: string, name: string, version: string): Promise<void> {
  const pkgDir = join(root, "node_modules", name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version, type: "module", exports: { ".": "./index.js" } }, null, 2),
  );
  await writeFile(join(pkgDir, "index.js"), "export default {};\n");
}

describe("installedVersions", () => {
  it("reads the version of a package whose exports map does not export ./package.json", async () => {
    await installFakePackage(dir, "@michaelthielemann/kestrel-fake", "6.0.0");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-fake": "^6.0.0" } }));
    const { installed, mixedMajors } = installedVersions(dir);
    expect(installed["@michaelthielemann/kestrel-fake"]).toBe("6.0.0");
    expect(mixedMajors).toBe(false);
  });

  it("still omits a dependency that genuinely cannot be resolved", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-not-installed": "^6.0.0" } }));
    const { installed } = installedVersions(dir);
    expect(installed["@michaelthielemann/kestrel-not-installed"]).toBeUndefined();
  });

  it("flags mixed majors across resolvable packages", async () => {
    await installFakePackage(dir, "@michaelthielemann/kestrel-a", "6.0.0");
    await installFakePackage(dir, "@michaelthielemann/kestrel-b", "5.8.0");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-a": "^6.0.0", "@michaelthielemann/kestrel-b": "^5.8.0" } }),
    );
    expect(installedVersions(dir).mixedMajors).toBe(true);
  });
});
