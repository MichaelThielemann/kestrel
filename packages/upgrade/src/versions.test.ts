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
    await installFakePackage(dir, "@michaelthielemann/kestrel-events-inmemory", "6.0.0");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-events-inmemory": "^6.0.0" } }));
    const { installed, mixedMajors } = installedVersions(dir);
    expect(installed["@michaelthielemann/kestrel-events-inmemory"]).toBe("6.0.0");
    expect(mixedMajors).toBe(false);
  });

  it("still omits a dependency that genuinely cannot be resolved", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-not-installed": "^6.0.0" } }));
    const { installed } = installedVersions(dir);
    expect(installed["@michaelthielemann/kestrel-not-installed"]).toBeUndefined();
  });

  it("flags mixed majors across resolvable backend packages", async () => {
    await installFakePackage(dir, "@michaelthielemann/kestrel-events-inmemory", "6.0.0");
    await installFakePackage(dir, "@michaelthielemann/kestrel-persistence-sqlite", "5.8.0");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-events-inmemory": "^6.0.0", "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }),
    );
    expect(installedVersions(dir).mixedMajors).toBe(true);
  });

  it("never flags mixed majors from a plugin's own package, even one on a different major", async () => {
    await installFakePackage(dir, "@michaelthielemann/kestrel-events-inmemory", "6.0.0");
    await installFakePackage(dir, "@michaelthielemann/kestrel-example-plugin", "1.0.0");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-events-inmemory": "^6.0.0", "@michaelthielemann/kestrel-example-plugin": "^1.0.0" } }),
    );
    const { installed, mixedMajors } = installedVersions(dir);
    expect(installed["@michaelthielemann/kestrel-example-plugin"]).toBe("1.0.0");
    expect(mixedMajors).toBe(false);
  });

  it("flags a real backend package at another major as mixed with no way to exempt it", async () => {
    await installFakePackage(dir, "@michaelthielemann/kestrel-events-inmemory", "6.0.0");
    await installFakePackage(dir, "@michaelthielemann/kestrel-persistence-sqlite", "5.8.0");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-events-inmemory": "^6.0.0", "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }),
    );
    expect(installedVersions(dir).mixedMajors).toBe(true);
  });
});
