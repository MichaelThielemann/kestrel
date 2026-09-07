import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.*/**", "examples/nginx-njs/**"] },
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
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
          message: "`as unknown as T` is banned; use boundaryCast<T>(value, boundary) from @michaelthielemann/kestrel/cast at a JSON, AST, DOM or host boundary.",
        },
        {
          selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
          message: "`as any` is banned.",
        },
      ],
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
    files: ["packages/*/**/*.ts"],
    ignores: ["packages/core/**", "packages/contracts/**", "packages/h3/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@michaelthielemann/kestrel-*", "!@michaelthielemann/kestrel-contracts", "!@michaelthielemann/kestrel-contracts/*", "../*"], message: "A module may only import the core, the contracts, its own files, Node and its package dependencies." },
            { group: ["h3", "nuxt", "nuxt/*", "#imports", "nitropack", "nitropack/*", "express", "hono", "vue", "@nuxt/*"], message: "A module may not import a host framework; adapters (e.g. kestrel-h3) bind the runtime, modules stay framework-agnostic." },
          ],
        },
      ],
    },
  },
  {
    // tests may exercise a module against another module it declares as a devDependency; pnpm's
    // non-hoisted node_modules still rejects anything undeclared
    files: ["packages/*/**/*.test.ts"],
    ignores: ["packages/core/**", "packages/contracts/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["../*"], message: "A module may only import the core, the contracts, its own files, Node and its package dependencies." }] }],
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
