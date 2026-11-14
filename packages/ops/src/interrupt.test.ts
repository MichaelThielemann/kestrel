import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, type Harness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

function signalAfterStop(h: Harness, emit: () => void): void {
  const stop = h.app.stop.bind(h.app);
  h.app.stop = async () => {
    const stopped = await stop();
    emit();
    return stopped;
  };
}

async function cleanState(h: Harness): Promise<void> {
  const report = await h.run(["status", "--json"]);
  expect(report.json.locks).toEqual([]);
  expect(report.json.openRuns).toEqual([]);
}

describe("SIGINT and SIGTERM", () => {
  it("start a frozen app again, release the lock and end the journal when they arrive after the stop", async () => {
    const signals = new EventEmitter();
    const h = createHarness({ store: memoryStore(new MemoryBucket("interrupt-freeze")) });
    try {
      await h.app.start();
      await h.app.seed();
      signalAfterStop(h, () => signals.emit("SIGINT"));
      const frozen = await h.run(["backup", "create", "--freeze", "--json"], { signals });
      expect(frozen.code).toBe(1);
      expect(frozen.stderr).toContain("interrupted by SIGINT");
      expect(frozen.json).toMatchObject({ schema: "kestrel-ops/error@1", message: "interrupted by SIGINT" });
      expect((await h.app.status()).state).toBe("started");
      expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0);
      await cleanState(h);
    } finally {
      await h.dispose();
    }
  });

  it("start the app again unchanged when they arrive during a restore before it changed the store", async () => {
    const signals = new EventEmitter();
    const h = createHarness({ store: memoryStore(new MemoryBucket("interrupt-restore")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      h.app.run(`UPDATE pages SET "body" = 'kept' WHERE "id" = 'home'`);
      await h.app.sync();
      signalAfterStop(h, () => signals.emit("SIGTERM"));
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })], { signals });
      expect(restored.code).toBe(1);
      expect(restored.stderr).toContain("interrupted by SIGTERM");
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Home", body: "kept" });
      await cleanState(h);
    } finally {
      await h.dispose();
    }
  });

  it("end a pending question and leave the app running", async () => {
    const signals = new EventEmitter();
    const h = createHarness({ store: memoryStore(new MemoryBucket("interrupt-prompt")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      const restored = await h.run(["restore", "--backup", String(backup.json.id)], {
        signals,
        prompt: () => {
          signals.emit("SIGINT");
          return new Promise<string>(() => undefined);
        },
      });
      expect(restored.code).toBe(1);
      expect(restored.stderr).toContain("interrupted by SIGINT");
      expect((await h.app.status()).state).toBe("started");
      await cleanState(h);
    } finally {
      await h.dispose();
    }
  });

  it("start the app again when a real SIGINT reaches the process during a frozen backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-ops-signal-"));
    try {
      const url = (file: string): string => pathToFileURL(join(SRC, file)).href;
      const script = join(dir, "child.mjs");
      writeFileSync(
        script,
        `const { createHarness } = await import(${JSON.stringify(url("harness.fixture.ts"))});
const { MemoryBucket, memoryStore } = await import(${JSON.stringify(url("memoryStore.ts"))});
const h = createHarness({ store: memoryStore(new MemoryBucket("child")) });
await h.app.start();
await h.app.seed();
const stop = h.app.stop.bind(h.app);
h.app.stop = async () => {
  const stopped = await stop();
  process.kill(process.pid, "SIGINT");
  await new Promise((done) => setTimeout(done, 50));
  return stopped;
};
const frozen = await h.run(["backup", "create", "--freeze"]);
h.app.stop = stop;
const status = await h.run(["status", "--json"]);
const state = (await h.app.status()).state;
process.stdout.write(JSON.stringify({ code: frozen.code, stderr: frozen.stderr, state, locks: status.json.locks, openRuns: status.json.openRuns }));
await h.dispose();
`,
      );
      const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((done) => {
        const child = execFile(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", script], { cwd: dir, timeout: 60_000 }, (_error, stdout, stderr) => done({ code: child.exitCode, signal: child.signalCode, stdout, stderr }));
      });
      expect(result.signal, result.stderr).toBeNull();
      expect(result.code, result.stderr).toBe(0);
      const report = boundaryCast<Record<string, unknown>>(JSON.parse(result.stdout), "json");
      expect(report).toMatchObject({ code: 1, state: "started", locks: [], openRuns: [] });
      expect(String(report.stderr)).toContain("interrupted by SIGINT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
