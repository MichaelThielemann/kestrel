import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boot, checkBoot, silentLogger, type BootInput } from "@michaelthielemann/kestrel";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";

const root = dirname(fileURLToPath(import.meta.url));

async function isolatedInput(dataDir: string): Promise<BootInput> {
  const configInput = await loadConfig(join(root, "kestrel.config.ts"));
  const config: KestrelConfigInput = {
    ...configInput,
    http: null,
    modules: configInput.modules.map((m) => {
      if (m.use === "@michaelthielemann/kestrel-persistence-sqlite") return { ...m, config: { ...(m.config as object), file: ":memory:" } };
      if (m.use === "@michaelthielemann/kestrel-replication-sqlite") return { ...m, config: { ...(m.config as object), file: join(dataDir, "replication.db") } };
      if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") return { ...m, config: { ...(m.config as object), root: join(dataDir, "blobs") } };
      return m;
    }),
  };
  return { config, modules: await loadModules(root, config), pipelines: await loadPipelines(root, "pipelines"), root, logger: silentLogger };
}

describe("examples/minimal boot check manifest", { timeout: 30_000 }, () => {
  it("checkBoot with every setup returns the manifest a real boot describes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kestrel-minimal-check-"));
    try {
      const check = await checkBoot(await isolatedInput(dataDir), { setup: "all" });
      expect(check.errors).toEqual([]);
      const kestrel = await boot(await isolatedInput(dataDir));
      try {
        expect(check.manifest).toEqual(kestrel.describe());
      } finally {
        await kestrel.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
