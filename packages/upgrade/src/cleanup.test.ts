import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-cleanup-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("trackTempDir", () => {
  it("removes the tracked directory when the process receives SIGINT", async () => {
    const scriptFile = join(dir, "script.mjs");
    const trackedDirFile = join(dir, "tracked-dir.txt");
    const cleanupModule = join(import.meta.dirname, "cleanup.ts");
    await writeFile(
      scriptFile,
      `
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackTempDir } from ${JSON.stringify(cleanupModule)};
const target = await mkdtemp(join(tmpdir(), "kestrel-upgrade-cleanup-target-"));
trackTempDir(target);
await writeFile(${JSON.stringify(trackedDirFile)}, target);
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [scriptFile], { stdio: "ignore" });
    await new Promise<void>((resolvePromise) => {
      const check = setInterval(() => {
        if (existsSync(trackedDirFile)) {
          clearInterval(check);
          resolvePromise();
        }
      }, 20);
    });
    const { readFile } = await import("node:fs/promises");
    const targetDir = (await readFile(trackedDirFile, "utf8")).trim();
    expect(existsSync(targetDir)).toBe(true);
    child.kill("SIGINT");
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    expect(existsSync(targetDir)).toBe(false);
  });
});
