import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

const HOOK = `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    appendFileSync(process.env.LOAD_TRACE_FILE, result.url + "\\n");
    return result;
  },
});
`;

function loadedUrls(file: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-upgrade-light-"));
  try {
    const hook = join(dir, "hook.mjs");
    const trace = join(dir, "trace.txt");
    writeFileSync(hook, HOOK);
    writeFileSync(trace, "");
    execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(hook).href, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)});`], { env: { ...process.env, LOAD_TRACE_FILE: trace } });
    return readFileSync(trace, "utf8").split("\n").filter((line) => line !== "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the light subpaths a command imports without the source rewriting engine", () => {
  for (const subpath of ["project", "scratch", "sandbox", "hosts"]) {
    it(`./${subpath} never loads @babel/parser`, () => {
      const urls = loadedUrls(join(SRC, `${subpath}.ts`));
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((url) => url.includes("@babel/"))).toEqual([]);
    });
  }

  it("./plugin does load it, so the check above can see it", () => {
    expect(loadedUrls(join(SRC, "plugin.ts")).some((url) => url.includes("@babel/parser"))).toBe(true);
  });
});
