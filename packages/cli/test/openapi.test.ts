import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyProject, FIXTURES, MINIMAL, removeDir, runCli, tempDir } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function storageFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => !file.startsWith("node_modules") && (/\.db(-wal|-shm)?$/.test(file) || file.startsWith("data")));
}

describe("kestrel openapi", { timeout: 60_000 }, () => {
  it("reproduces the committed document of the minimal example and opens none of its storage", async () => {
    const dir = copyProject(MINIMAL, "openapi");
    dirs.push(dir);
    const result = await runCli(["openapi", "--out", "generated.json", "--server", "http://127.0.0.1:4000"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/^wrote generated\.json \(\d+ paths\)\n$/);
    expect(readFileSync(join(dir, "generated.json"), "utf8")).toBe(readFileSync(join(MINIMAL, "openapi.json"), "utf8"));
    expect(storageFiles(dir)).toEqual([]);
  });

  it("refuses a module outside the sandbox unless --run-setup names it, and then runs it only in the scratch copy", async () => {
    const dir = copyProject(join(FIXTURES, "setup-marker"), "openapi-marker");
    dirs.push(dir);
    const logDir = tempDir("openapi-log");
    dirs.push(logDir);
    const log = join(logDir, "cwd.txt");
    const refused = await runCli(["openapi", "--root", dir], { env: { KESTREL_MARKER_LOG: log } });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("outside the sandbox");
    expect(refused.stderr).toContain("  ./modules/marker.ts");
    expect(existsSync(log)).toBe(false);

    const allowed = await runCli(["openapi", "--root", dir, "--run-setup", "./modules/marker.ts"], { env: { KESTREL_MARKER_LOG: log } });
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ openapi: "3.1.0" });
    expect(readFileSync(log, "utf8")).toContain("kestrel-upgrade-");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("refuses an unknown flag", async () => {
    const result = await runCli(["openapi", "--pretty", "--root", MINIMAL]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option "--pretty"');
  });
});
