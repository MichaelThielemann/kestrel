import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.contract.test.ts", "**/.*/**", "test-fixtures/**"],
    globalSetup: ["scripts/objectBinding.globalSetup.ts"],
    poolOptions: { forks: { execArgv: ["--disable-warning=ExperimentalWarning"] } },
    server: { deps: { external: [/^node:sqlite$/] } },
  },
});
