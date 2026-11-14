import js from "@eslint/js";
import tseslint from "typescript-eslint";

const contractImportPatterns = [
  { group: ["@michaelthielemann/*", "!@michaelthielemann/kestrel", "!@michaelthielemann/kestrel/*", "!@michaelthielemann/kestrel-contracts", "!@michaelthielemann/kestrel-contracts/*"], message: "A contract imports only the core and its own files." },
  { group: ["zod", "h3", "nuxt", "nuxt/*", "\\#imports", "nitropack", "nitropack/*", "express", "hono", "vue", "@nuxt/*"], message: "A contract file is domain-neutral TypeScript: no validation library, no host framework." },
];

const castSelectors = [
  {
    selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
    message: "`as unknown as T` is banned; use boundaryCast<T>(value, boundary) from @michaelthielemann/kestrel/cast at a JSON, AST, DOM or host boundary.",
  },
  {
    selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
    message: "`as any` is banned.",
  },
];

const cliStartPathFiles = ["packages/cli/src/cli.ts", "packages/cli/src/kestrel-cli.ts", "packages/cli/src/dispatch.ts", "packages/cli/src/commands/start.ts", "packages/cli/src/projectCore.ts"];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.*/**", "examples/nginx-njs/**", "test-fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "as", objectLiteralTypeAssertions: "never" }],
      "no-restricted-syntax": ["error", ...castSelectors],
    },
  },
  {
    files: ["eslint.config.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly", URL: "readonly" },
    },
  },
  {
    files: ["packages/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-type-assertion": "error",
    },
  },
  {
    files: ["packages/*/**/*.ts"],
    ignores: ["packages/core/**", "packages/contracts/**", "packages/h3/**", "packages/cli/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@michaelthielemann/kestrel-*", "!@michaelthielemann/kestrel-contracts", "!@michaelthielemann/kestrel-contracts/*", "../*"], message: "A module may only import the core, the contracts, its own files, Node and its package dependencies." },
            { group: ["h3", "nuxt", "nuxt/*", "\\#imports", "nitropack", "nitropack/*", "express", "hono", "vue", "@nuxt/*"], message: "A module may not import a host framework; adapters (e.g. kestrel-h3) bind the runtime, modules stay framework-agnostic." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/*/**/*.test.ts", "packages/*/__fixtures__/**/*.ts"],
    ignores: ["packages/core/**", "packages/contracts/**", "packages/cli/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["../*"], message: "A module may only import the core, the contracts, its own files, Node and its package dependencies." }] }],
    },
  },
  {
    files: ["packages/ops/src/update/**/*.ts"],
    ignores: ["packages/ops/src/update/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@michaelthielemann/kestrel-*", "!@michaelthielemann/kestrel-contracts", "!@michaelthielemann/kestrel-contracts/*", "../../*"], message: "The update sources import the ops sources one level up, the core, the contracts, Node and the package's dependencies." },
            { group: ["h3", "nuxt", "nuxt/*", "\\#imports", "nitropack", "nitropack/*", "express", "hono", "vue", "@nuxt/*"], message: "A module may not import a host framework; adapters (e.g. kestrel-h3) bind the runtime, modules stay framework-agnostic." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ops/src/update/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["../../*"], message: "The update tests import the ops sources one level up, Node and the package's dependencies." }] }],
    },
  },
  {
    files: ["packages/*/*.interleaving.test.ts", "packages/*/*.permanence.test.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["packages/cli/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["h3", "nuxt", "nuxt/*", "\\#imports", "nitropack", "nitropack/*", "express", "hono", "vue", "@nuxt/*"], message: "The CLI binds no host framework; a host package registers a plugin instead." }],
        },
      ],
    },
  },
  {
    files: cliStartPathFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@michaelthielemann/kestrel-upgrade", "@michaelthielemann/kestrel-upgrade/*", "@michaelthielemann/kestrel-openapi", "@michaelthielemann/kestrel-openapi/*", "@babel/*", "jiti", "jiti/*"], message: "The start path loads nothing but the project's own core." },
            { group: ["./inspectProject*", "../inspectProject*", "./inspect/*", "../inspect/*", "./commands/*", "../commands/*", "./check*", "./explain*", "./manifest*", "./openapi*", "./upgrade*"], message: "The start path imports no other command and no inspection code." },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...castSelectors, { selector: "ImportExpression", message: "The start path imports one command and the project's core, nothing else, at run time." }],
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@michaelthielemann/kestrel-*"], message: "The core knows no contract and no module." },
            { group: ["h3", "nuxt", "nuxt/*", "\\#imports", "nitropack", "nitropack/*", "express", "hono", "vue", "@nuxt/*"], message: "The core binds no host framework; adapters (e.g. kestrel-h3) do." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/contracts/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: contractImportPatterns }] },
  },
  {
    files: ["packages/contracts/**/*.ts"],
    ignores: ["packages/contracts/**/*.contract.test.ts", "packages/contracts/src/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...contractImportPatterns,
            { group: ["@michaelthielemann/kestrel/definePipeline", "@michaelthielemann/kestrel/testing/runPipeline"], message: "A contract file stays runner-free; definePipeline and runPipeline belong to *.contract.test.ts and src/testing/*." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/h3/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@michaelthielemann/kestrel-*"], message: "The adapter knows neither contracts nor modules; it binds the core to h3." },
          ],
        },
      ],
    },
  },
  {
    files: ["examples/*/pipelines/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@michaelthielemann/kestrel-*", "!@michaelthielemann/kestrel-contracts"], message: "Pipelines reference steps by name only." }] },
      ],
    },
  },
);
