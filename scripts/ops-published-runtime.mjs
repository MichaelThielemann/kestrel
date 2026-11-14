#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(repo, "fixtures", "upgrade", "5.8.1", "manifest.json"), "utf8"));
const packages = ["kestrel-replication-sqlite", "kestrel", "kestrel-contracts"].map((name) => `@michaelthielemann/${name}`);
const dir = mkdtempSync(join(tmpdir(), "kestrel-published-runtime-"));

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
}

let code = 1;
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", ...packages.map((name) => `${name}@${version}`)], { cwd: dir });
  for (const name of packages) {
    const installed = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version;
    if (installed !== version) throw new Error(`${name} resolved to ${installed}, expected ${version}`);
  }
  const vitest = spawnSync(join(repo, "node_modules", ".bin", "vitest"), ["run", "packages/ops/src/publishedRuntime.test.ts"], { cwd: repo, stdio: "inherit", env: { ...process.env, KESTREL_OPS_PUBLISHED_RUNTIME: dir } });
  code = vitest.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
