import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import module, { configSchema } from "./module.ts";
import type { Validator } from "./impl.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-validate-jsonschema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, "blocks.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { title: { type: "string" } } }));

describe("validate/jsonschema module", () => {
  it("resolves relative schema paths against deps.root, not process.cwd()", async () => {
    const config = configSchema.parse({ schemas: { "pages.title": "blocks.json" } });
    const instance = (await module.setup(config, {
      get: () => {
        throw new Error("no contract expected");
      },
      find: () => undefined,
      logger: silentLogger,
      root: dir,
    })) as Validator;
    expect(instance.targets()).toEqual(["pages.title"]);
    expect(dir).not.toBe(process.cwd());
    instance.close();
  });

  it("accepts an inline schema object next to a path", () => {
    const config = configSchema.parse({ schemas: { "pages.title": "blocks.json", "settings.navigation": { type: "array" } } });
    expect(config.schemas).toEqual({ "pages.title": "blocks.json", "settings.navigation": { type: "array" } });
    expect(() => configSchema.parse({ schemas: { "pages.title": "" } })).toThrow();
    expect(() => configSchema.parse({ schemas: { "pages.title": 3 } })).toThrow();
  });
});
