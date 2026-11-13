import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { ESLint, type Linter } from "eslint";
import { describe, it, expect, beforeAll } from "vitest";
// @ts-expect-error eslint.config.js has no type declarations
import baseConfigUntyped from "../eslint.config.js";

const baseConfig = baseConfigUntyped as Linter.Config[];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(root, "test-fixtures/eslint");

interface Expectation {
  file: string;
  ruleId: string;
  message?: string;
}

const expectations: Expectation[] = [
  { file: "casts/as-unknown-as.ts", ruleId: "no-restricted-syntax", message: "`as unknown as T` is banned; use boundaryCast<T>(value, boundary) from @michaelthielemann/kestrel/cast at a JSON, AST, DOM or host boundary." },
  { file: "casts/as-any.ts", ruleId: "no-restricted-syntax", message: "`as any` is banned." },
  { file: "packages/some-module/src/restricted-module-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel-other-module' import is restricted from being used by a pattern. A module may only import the core, the contracts, its own files, Node and its package dependencies." },
  { file: "packages/some-module/src/restricted-module-import.ts", ruleId: "no-restricted-imports", message: "'h3' import is restricted from being used by a pattern. A module may not import a host framework; adapters (e.g. kestrel-h3) bind the runtime, modules stay framework-agnostic." },
  { file: "packages/some-module/src/restricted-module-import.ts", ruleId: "@typescript-eslint/no-unsafe-type-assertion" },
  { file: "packages/some-module/restricted-test-import.test.ts", ruleId: "no-restricted-imports", message: "'../other-module/helper' import is restricted from being used by a pattern. A module may only import the core, the contracts, its own files, Node and its package dependencies." },
  { file: "packages/core/restricted-core-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel-other-module' import is restricted from being used by a pattern. The core knows no contract and no module." },
  { file: "packages/core/restricted-core-import.ts", ruleId: "no-restricted-imports", message: "'nuxt' import is restricted from being used by a pattern. The core binds no host framework; adapters (e.g. kestrel-h3) do." },
  { file: "packages/core/restricted-hash-import.ts", ruleId: "no-restricted-imports", message: "'#imports' import is restricted from being used by a pattern. The core binds no host framework; adapters (e.g. kestrel-h3) do." },
  { file: "packages/contracts/restricted-contracts-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel-other-module' import is restricted from being used by a pattern. A contract imports only the core and its own files." },
  { file: "packages/contracts/restricted-contracts-import.ts", ruleId: "no-restricted-imports", message: "'zod' import is restricted from being used by a pattern. A contract file is domain-neutral TypeScript: no validation library, no host framework." },
  { file: "packages/contracts/restricted-contracts-import.ts", ruleId: "no-restricted-imports", message: "'zod/mini' import is restricted from being used by a pattern. A contract file is domain-neutral TypeScript: no validation library, no host framework." },
  { file: "packages/contracts/restricted-pipeline-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel/definePipeline' import is restricted from being used by a pattern. A contract file stays runner-free; definePipeline and runPipeline belong to *.contract.test.ts and src/testing/*." },
  { file: "packages/contracts/restricted-pipeline-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel/testing/runPipeline' import is restricted from being used by a pattern. A contract file stays runner-free; definePipeline and runPipeline belong to *.contract.test.ts and src/testing/*." },
  { file: "packages/contracts/restricted-imports.contract.test.ts", ruleId: "no-restricted-imports", message: "'zod' import is restricted from being used by a pattern. A contract file is domain-neutral TypeScript: no validation library, no host framework." },
  { file: "packages/h3/restricted-h3-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel-other-module' import is restricted from being used by a pattern. The adapter knows neither contracts nor modules; it binds the core to h3." },
  { file: "examples/some-example/pipelines/restricted-pipeline-import.ts", ruleId: "no-restricted-imports", message: "'@michaelthielemann/kestrel-other-module' import is restricted from being used by a pattern. Pipelines reference steps by name only." },
];

const fixtureProjectService: Linter.Config = {
  files: ["**/*.ts"],
  languageOptions: {
    parserOptions: { projectService: true, tsconfigRootDir: fixturesRoot },
  },
};

let messagesByFile: Map<string, Linter.LintMessage[]>;

beforeAll(async () => {
  const eslint = new ESLint({
    cwd: fixturesRoot,
    ignore: false,
    overrideConfigFile: true,
    baseConfig: [...baseConfig, fixtureProjectService],
  });
  const results = await eslint.lintFiles(["**/*.ts"]);
  messagesByFile = new Map(results.map((r) => [r.filePath.replace(fixturesRoot + "/", ""), r.messages]));
});

describe("project-specific ESLint rules", () => {
  const files = [...new Set(expectations.map((e) => e.file))];

  it.each(files)("has a fixture at %s that was linted", (file) => {
    expect(messagesByFile.has(file)).toBe(true);
  });

  it.each(expectations)("$file reports $ruleId", ({ file, ruleId, message }) => {
    const messages = messagesByFile.get(file) ?? [];
    const match = messages.find((m) => m.ruleId === ruleId && (message === undefined || m.message === message));
    expect(match, `expected ${ruleId}${message ? ` (${JSON.stringify(message)})` : ""} in ${file}, got ${JSON.stringify(messages.map((m) => [m.ruleId, m.message]))}`).toBeTruthy();
  });

  it("lets a contract test file import the pipeline runner", () => {
    const messages = messagesByFile.get("packages/contracts/restricted-imports.contract.test.ts") ?? [];
    expect(messages.filter((m) => m.message.includes("definePipeline") || m.message.includes("runPipeline"))).toEqual([]);
  });
});
