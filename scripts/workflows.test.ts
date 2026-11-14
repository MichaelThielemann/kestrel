import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

function workflow(name: string): string {
  return readFileSync(join(WORKFLOWS, name), "utf8");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function block(lines: readonly string[], start: number): string[] {
  const indent = indentOf(lines[start] ?? "");
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() !== "" && indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

function jobs(source: string): Map<string, string[]> {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  const result = new Map<string, string[]>();
  if (start === -1) return result;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^ {2}([\w-]+):\s*$/.exec(lines[i] ?? "");
    if (match?.[1] !== undefined) result.set(match[1], block(lines, i));
  }
  return result;
}

function topLevel(source: string, key: string): string[] | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return undefined;
  const inline = (lines[start] ?? "").slice(key.length + 1).trim();
  return inline === "" ? block(lines, start) : [inline];
}

function job(source: string, name: string): string {
  const lines = jobs(source).get(name);
  if (lines === undefined) throw new Error(`no job "${name}"`);
  return lines.join("\n");
}

describe("the release workflow", () => {
  const release = workflow("release.yml");

  it("grants no permission at the top level", () => {
    expect(topLevel(release, "permissions")).toEqual(["{}"]);
  });

  it("builds, tests and packs in a job that cannot mint an id token", () => {
    const build = job(release, "build");
    expect(build).toMatch(/permissions:\n\s+contents: read\n/);
    expect(build).not.toContain("id-token");
    expect(build).toContain("pnpm install --frozen-lockfile");
    expect(build).toContain("node scripts/release.mjs plan");
    expect(build).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
  });

  it("publishes in a job that needs the build, runs in the release environment, and is the only one with id-token: write", () => {
    const names = [...jobs(release).keys()];
    expect(names.filter((name) => job(release, name).includes("id-token: write"))).toEqual(["publish"]);
    const publish = job(release, "publish");
    expect(publish).toMatch(/needs: build\n/);
    expect(publish).toMatch(/environment: release\n/);
    expect(publish).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write\n/);
    expect(publish).toMatch(/actions\/download-artifact@[0-9a-f]{40}/);
    expect(publish).toContain("node scripts/release.mjs publish");
  });

  it("installs no dependency in the publish job", () => {
    const publish = job(release, "publish");
    expect(publish).not.toMatch(/pnpm (?:install|i|add)\b|npm (?:install|ci|i)\b|yarn install|pnpm run|pnpm (?:lint|test|build)/);
  });

  it("restores no package manager cache anywhere in the release path", () => {
    expect(release).not.toMatch(/^\s+cache:/m);
    expect(release).not.toContain("actions/cache");
  });

  it("checks out without persisting the token", () => {
    for (const name of jobs(release).keys()) expect(job(release, name), name).toMatch(/actions\/checkout@[0-9a-f]{40}.*\n\s+with:\n\s+persist-credentials: false/);
  });
});

describe("the ci workflow", () => {
  const ci = workflow("ci.yml");

  it("grants no permission at the top level and read-only contents to its job", () => {
    expect(topLevel(ci, "permissions")).toEqual(["{}"]);
    for (const name of jobs(ci).keys()) expect(job(ci, name), name).toMatch(/permissions:\n\s+contents: read\n/);
  });

  it("checks out without persisting the token", () => {
    for (const name of jobs(ci).keys()) expect(job(ci, name), name).toMatch(/actions\/checkout@[0-9a-f]{40}.*\n\s+with:\n\s+persist-credentials: false/);
  });

  it("runs the kestrel-ops tests on macOS from a frozen install", () => {
    const macos = job(ci, "ops-macos");
    expect(macos).toMatch(/runs-on: macos-latest/);
    expect(macos).toMatch(/- run: pnpm install --frozen-lockfile\n\s+- run: pnpm vitest run packages\/ops/);
  });

  it("boots the upgrade fixture on the published replication package of its release in a job of its own", () => {
    const published = job(ci, "ops-published-runtime");
    expect(published).toMatch(/runs-on: ubuntu-latest/);
    expect(published).toMatch(/- run: pnpm install --frozen-lockfile\n\s+- run: pnpm test:published-runtime/);
  });
});

describe("every workflow", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

  it("pins every action to a full commit sha", () => {
    for (const file of files) {
      for (const match of workflow(file).matchAll(/uses:\s*(\S+)/g)) expect(match[1], `${file}: ${match[1]}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("takes pnpm from the packageManager field, which pins the version and its hash", () => {
    const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const packageManager: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "packageManager") : undefined;
    expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    for (const file of files) {
      const lines = workflow(file).split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("pnpm/action-setup@")) return;
        const next = lines[i + 1] ?? "";
        expect(next.trim().startsWith("with:") && /version:/.test(lines[i + 2] ?? ""), `${file}: pnpm/action-setup sets a version`).toBe(false);
      });
    }
  });
});
