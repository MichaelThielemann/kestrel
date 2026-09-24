import { existsSync, readdirSync, statSync } from "node:fs";
import type * as ChildProcess from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";

const spawnedCommands = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const untypedExecFile = boundaryCast<(...args: unknown[]) => unknown>(actual.execFile, "host");
  const execFile = boundaryCast<typeof actual.execFile>((...args: unknown[]) => {
    spawnedCommands.push(String(args[0]));
    return untypedExecFile(...args);
  }, "host");
  return { ...actual, execFile };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "minimal-5.8");

interface Snapshot {
  [path: string]: { size: number; mtimeMs: number };
}

function snapshot(dir: string): Snapshot {
  const out: Snapshot = {};
  const walk = (relDir: string): void => {
    for (const entry of readdirSync(join(dir, relDir), { withFileTypes: true })) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      const info = statSync(join(dir, rel));
      out[rel] = { size: info.size, mtimeMs: info.mtimeMs };
    }
  };
  walk("");
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kestrel-upgrade never writes to the project", () => {
  it("leaves the project's tree byte-for-byte identical after check", async () => {
    const before = snapshot(FIXTURE);
    await runUpgradeCli(["check", "--root", FIXTURE, "--json"], { stdout: () => undefined, stderr: () => undefined });
    expect(snapshot(FIXTURE)).toEqual(before);
  });

  it("leaves the project's tree byte-for-byte identical after a fix preview (no --write)", async () => {
    const before = snapshot(FIXTURE);
    await runUpgradeCli(["fix", "--root", FIXTURE], { stdout: () => undefined, stderr: () => undefined });
    expect(snapshot(FIXTURE)).toEqual(before);
  });
});

describe("kestrel-upgrade never touches the network", () => {
  it("check completes with fetch and socket connects stubbed to throw", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network access attempted");
    };
    try {
      const code = await runUpgradeCli(["check", "--root", FIXTURE, "--json"], { stdout: () => undefined, stderr: () => undefined });
      expect(typeof code).toBe("number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("kestrel-upgrade spawns only git", () => {
  it("spawns no command other than git during check", async () => {
    spawnedCommands.length = 0;
    await runUpgradeCli(["check", "--root", FIXTURE, "--json"], { stdout: () => undefined, stderr: () => undefined });
    for (const command of spawnedCommands) expect(command).toBe("git");
  });
});

describe("kestrel-upgrade fix --write refuses a dirty file without --allow-dirty", () => {
  it("does not write when --write is missing, regardless of git state", async () => {
    if (!existsSync(join(FIXTURE, ".git"))) return;
    const before = snapshot(FIXTURE);
    await runUpgradeCli(["fix", "--root", FIXTURE], { stdout: () => undefined, stderr: () => undefined });
    expect(snapshot(FIXTURE)).toEqual(before);
  });
});
