import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { runOps } from "./run.ts";
import type { Target } from "./target.ts";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "upgrade", "5.8.1");
const LOCATION = "kestrel-backups/";

interface FixtureManifest {
  version: string;
  packages: Record<string, string>;
  missingOriginal: string;
  media: Record<string, { id: string; key: string }>;
  collections: Record<string, number>;
}

const fixture = boundaryCast<FixtureManifest>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function loadBlobs(bucket: MemoryBucket): void {
  const blobs = join(FIXTURE, "blobs");
  for (const file of files(blobs)) bucket.write(relative(blobs, file).split("\\").join("/"), readFileSync(file), "put");
}

function stoppedTarget(packages: Record<string, string>): Target {
  return {
    transport: "promote",
    describe: async () => ({ kind: "fixture", packages }),
    status: async () => ({ state: "stopped", instances: 0 }),
    stop: async () => ({ stoppedAt: Date.now() }),
    start: async () => {
      throw new Error("the fixture target never starts");
    },
    waitReady: async () => false,
  };
}

describe("a replica and blobs written by the published 5.8.1 packages", () => {
  let root: string;
  let bucket: MemoryBucket;
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: Record<string, unknown> }> => {
    let stdout = "";
    let stderr = "";
    const store = memoryStore(bucket);
    const code = await runOps(args, {
      cwd: root,
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      targets: { fixture: () => stoppedTarget(fixture.packages) },
      stores: () => store,
      stateRoot: join(root, "state"),
      poll: { delayMs: 1, attempts: 20 },
      readyTimeoutMs: 100,
      project: { versions: fixture.packages, lockfileSha256: null },
    });
    const start = stdout.lastIndexOf('{\n  "schema"');
    const json = start < 0 ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(stdout.slice(start)), "json");
    return { code, stdout, stderr, json };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kestrel-ops-fixture-"));
    bucket = new MemoryBucket("fixture-5.8.1");
    loadBlobs(bucket);
    const environments = {
      environments: {
        prod: {
          target: { adapter: "fixture" },
          storage: { bucket: "fixture-5.8.1" },
          app: { replicaPrefix: "replica/", mediaPrefix: "media/", deliveryPrefix: "site/", derivedPrefixes: ["media-variants/"] },
          backups: { prefix: LOCATION },
        },
      },
    };
    writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify(environments, null, 2));
    writeFileSync(join(root, "answers.json"), JSON.stringify({ "unsealed-stop": "accept" }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports the seal as unsupported and refuses --yes without the unsealed-stop answer, writing no backup", async () => {
    expect(fixture.version).toBe("5.8.1");
    const refused = await run(["backup", "create", "--freeze", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("seal unsupported (runtime 5.8.1)");
    expect(refused.stderr).toContain("unsealed-stop");
    expect([...bucket.objects.keys()].filter((key) => key.startsWith(LOCATION) && key.endsWith("/manifest.json"))).toEqual([]);
  });

  it("backs up the database rebuilt from the replica row for row, every original that exists and the export, and the backup verifies", async () => {
    const backup = await run(["backup", "create", "--freeze", "--yes", "--answers", join(root, "answers.json"), "--json"]);
    expect(backup.code).toBe(0);
    const missing = Object.values(fixture.media).find((item) => item.id === fixture.missingOriginal)?.key;
    expect(missing).toBeDefined();
    expect(backup.stderr).toContain("seal unsupported (runtime 5.8.1)");
    expect(backup.stderr).toContain(`original ${missing} is referenced by a media row but missing in the store`);
    const manifest = boundaryCast<{ source: { seal: string }; db: { integrity: string; rows: Record<string, number> }; blobs: { count: number; missingAtBackup: string[] } }>(backup.json.manifest, "json");
    expect(manifest.source.seal).toBe("unsupported");
    expect(manifest.db.integrity).toBe("ok");
    expect(manifest.db.rows).toEqual(fixture.collections);
    expect(manifest.blobs).toMatchObject({ count: Object.keys(fixture.media).length - 1, missingAtBackup: [missing] });
    const verified = await run(["backup", "verify", String(backup.json.id), "--json"]);
    expect(verified.stderr).toBe("");
    expect(verified.code).toBe(0);
    expect(verified.json).toMatchObject({ ok: true });
  });
});
