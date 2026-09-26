import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot, silentLogger, type Manifest } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import type { CheckReport } from "../src/commands/check.ts";
import { MINIMAL, runCli } from "./harness.ts";

const STORAGE: Record<string, (dir: string) => Record<string, unknown>> = {
  "@michaelthielemann/kestrel-persistence-sqlite": () => ({ file: ":memory:" }),
  "@michaelthielemann/kestrel-replication-sqlite": (dir) => ({ file: join(dir, "replication.db") }),
  "@michaelthielemann/kestrel-blobstore-filesystem": (dir) => ({ root: join(dir, "blobs") }),
};

async function bootedManifest(): Promise<Manifest> {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-cli-manifest-"));
  try {
    const input = await loadConfig(join(MINIMAL, "kestrel.config.ts"));
    const config: KestrelConfigInput = { ...input, http: null, modules: input.modules.map((m) => (m.use in STORAGE ? { ...m, config: { ...boundaryCast<Record<string, unknown>>(m.config, "json"), ...STORAGE[m.use]!(dir) } } : m)) };
    const kestrel = await boot({ config, modules: await loadModules(MINIMAL, config), pipelines: await loadPipelines(MINIMAL, "pipelines"), root: MINIMAL, logger: silentLogger });
    try {
      return kestrel.describe();
    } finally {
      await kestrel.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withoutConfigOf(manifest: Manifest, uses: readonly string[]): unknown {
  return { ...manifest, modules: manifest.modules.map((m) => (uses.includes(m.use) ? { ...m, config: null } : m)) };
}

describe("kestrel manifest", { timeout: 60_000 }, () => {
  it("prints what a real boot describes, except the config of the modules the sandbox rewrote, which it flags", async () => {
    const result = await runCli(["manifest", "--json", "--root", MINIMAL]);
    expect(result.code).toBe(0);
    const printed = boundaryCast<Manifest>(JSON.parse(result.stdout), "json");
    const check = boundaryCast<CheckReport>(JSON.parse((await runCli(["check", "--json", "--root", MINIMAL])).stdout), "json");
    const rewritten = check.sandbox.rewritten;
    expect(rewritten.length).toBeGreaterThan(0);
    expect(withoutConfigOf(printed, rewritten)).toEqual(withoutConfigOf(await bootedManifest(), rewritten));
    for (const module of printed.modules.filter((m) => rewritten.includes(m.use))) {
      for (const variable of module.config.variables) expect(variable).toMatchObject({ sandboxed: true });
    }
    expect(JSON.stringify(printed)).not.toContain("kestrel-upgrade-");
  });

  it("prints tables of modules, pipelines and routes by default", async () => {
    const result = await runCli(["manifest", "--root", MINIMAL]);
    expect(result.code).toBe(0);
    for (const heading of ["modules", "contracts", "pipelines", "http routes", "event triggers", "crons", "warnings"]) expect(result.stdout).toContain(`${heading}\n`);
    expect(result.stdout).toContain("createPage");
  });
});
