import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runUpgradeCli } from "./plugin.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function contentProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-write-test-"));
  dirs.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
  const config = { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } };
  await writeFile(
    join(root, "kestrel.config.ts"),
    `export default { modules: [{ use: "@michaelthielemann/kestrel-content-default", config: ${JSON.stringify(config)} }], triggers: [] };\n`,
  );
  return root;
}

describe("kestrel-upgrade fix --write against an explicit, unproven underscore-field rename", () => {
  it("names the old column and how to check it in the post-write output", async () => {
    const root = await contentProjectRoot();
    const answersFile = join(root, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "underscore-field:page._hint": "hint" }));
    const lines: string[] = [];
    const code = await runUpgradeCli(["fix", "--root", root, "--write", "--yes", "--allow-dirty", "--answers", answersFile], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(lines).toContain("wrote kestrel.config.ts");
    const notice = lines.find((l) => l.includes("_hint"));
    expect(notice).toBeDefined();
    expect(notice).toMatch(/kestrel-upgrade data/);
  });
});
