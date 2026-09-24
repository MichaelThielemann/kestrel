import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runUpgradeCli } from "./plugin.ts";
import type { Rule, UpgradePlugin } from "./plugin.ts";
import { loadBackendProject } from "./project.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "queue-offer-5.8");

describe("previewBoot reloads from a fresh directory instead of the ESM-cached scratch path", () => {
  it("sees a boot error a preview edit introduces, instead of the stale pre-edit state", async () => {
    let seenErrorCount: number | undefined;
    const probeRule: Rule = {
      id: "probe/preview",
      async check(ctx) {
        if (!ctx.previewBoot) return [];
        const source = ctx.readFile(ctx.project.configFile)!;
        const insertAt = source.indexOf("triggers: [") + "triggers: [".length;
        const edit = { file: ctx.project.configFile, start: insertAt, end: insertAt, text: '{ event: "no.such.event", pipeline: "noSuchPipeline" }, ' };
        const check = await ctx.previewBoot([edit]);
        seenErrorCount = check?.errors.length;
        return [];
      },
    };
    const plugin: UpgradePlugin = {
      kind: "probe",
      detect: () => true,
      load: async (_root, dir) => loadBackendProject(dir),
      rules: [probeRule],
    };

    const lines: string[] = [];
    await runUpgradeCli(["check", "--root", FIXTURE, "--json", "--run-setup", "./notes.ts"], {
      stdout: (l) => lines.push(l),
      stderr: () => undefined,
      forceInstalledMajor: 6,
      plugins: [plugin],
    });
    expect(seenErrorCount).toBe(1);
  });
});
