import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackTempDir, untrackTempDir } from "./cleanup.ts";

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
    const targetDir = (await readFile(trackedDirFile, "utf8")).trim();
    expect(existsSync(targetDir)).toBe(true);
    child.kill("SIGINT");
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    expect(existsSync(targetDir)).toBe(false);
  });

  it("terminates via the signal's own default disposition rather than a hardcoded exit code, so SIGHUP is reported as SIGHUP", async () => {
    const scriptFile = join(dir, "sighup-script.mjs");
    const trackedDirFile = join(dir, "tracked-dir-sighup.txt");
    const cleanupModule = join(import.meta.dirname, "cleanup.ts");
    await writeFile(
      scriptFile,
      `
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackTempDir } from ${JSON.stringify(cleanupModule)};
const target = await mkdtemp(join(tmpdir(), "kestrel-upgrade-cleanup-target-sighup-"));
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
    const targetDir = (await readFile(trackedDirFile, "utf8")).trim();
    child.kill("SIGHUP");
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolvePromise) => {
      child.once("exit", (c, s) => resolvePromise([c, s]));
    });
    expect(existsSync(targetDir)).toBe(false);
    expect(signal).toBe("SIGHUP");
    expect(code).toBeNull();
  });

  it("installs its own listener only while a directory is tracked, and never removes a host's own listener", async () => {
    const hostHandler = (): void => undefined;
    process.on("SIGINT", hostHandler);
    try {
      const before = process.listenerCount("SIGINT");
      const target = await mkdtemp(join(tmpdir(), "kestrel-upgrade-cleanup-lifecycle-"));
      trackTempDir(target);
      const during = process.listenerCount("SIGINT");
      untrackTempDir(target);
      await rm(target, { recursive: true, force: true });
      const after = process.listenerCount("SIGINT");
      expect(during).toBe(before + 1);
      expect(after).toBe(before);
    } finally {
      process.removeListener("SIGINT", hostHandler);
    }
  });
});
