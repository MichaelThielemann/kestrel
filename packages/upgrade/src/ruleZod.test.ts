import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits } from "./apply.ts";
import type { SourceRuleContext } from "./plugin.ts";
import type { Finding } from "./report.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import { DEFAULT_RULES, readFileOrUndefined } from "./rules.ts";
import { zodDescribeOrderRule, zodObjectDefaultRule, zodRangeRule, zodRecordKeyRule } from "./ruleZod.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-zod-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function context(): SourceRuleContext {
  return { root: dir, scratch: dir, readFile: readFileOrUndefined, answers: new Map() };
}

async function write(relPath: string, content: string): Promise<string> {
  const file = join(dir, relPath);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
  return file;
}

function applied(finding: Finding | undefined, source: string): string {
  const edits = finding?.fix.kind === "auto" ? finding.fix.edits : [];
  return applyEdits(source, edits).text;
}

function dependencies(text: string, map: string): Record<string, string> {
  const pkg = boundaryCast<Record<string, Record<string, string>>>(JSON.parse(text), "json");
  return pkg[map] ?? {};
}

describe("deps/zod-range", () => {
  it("raises a zod 3 dependency to ^4.6.6", async () => {
    const source = `${JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel": "^6.0.0", zod: "^3.23.8" } }, null, 2)}\n`;
    await write("package.json", source);
    const findings = await zodRangeRule.check(context());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("deps/zod-range");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.docs).toBe(upgradingDocs("deps-zod-range"));
    expect(findings[0]?.message).toContain("^3.23.8");
    const text = applied(findings[0], source);
    expect(dependencies(text, "dependencies")).toEqual({ "@michaelthielemann/kestrel": "^6.0.0", zod: "^4.6.6" });
  });

  it("raises a zod 4 range that admits a release below 4.6.6, in whichever map lists it", async () => {
    const source = `${JSON.stringify({ name: "app", devDependencies: { zod: "^4.1.0" }, peerDependencies: { zod: ">=3.22.0" } }, null, 2)}\n`;
    await write("package.json", source);
    const findings = await zodRangeRule.check(context());
    expect(findings.map((f) => f.message)).toEqual([expect.stringContaining("devDependencies"), expect.stringContaining("peerDependencies")]);
    const { text } = applyEdits(source, findings.flatMap((f) => (f.fix.kind === "auto" ? f.fix.edits : [])));
    expect(dependencies(text, "devDependencies")).toEqual({ zod: "^4.6.6" });
    expect(dependencies(text, "peerDependencies")).toEqual({ zod: "^4.6.6" });
  });

  it("raises a range written without a full version, such as ^4", async () => {
    await write("package.json", JSON.stringify({ name: "app", dependencies: { zod: "^4" } }));
    expect(await zodRangeRule.check(context())).toHaveLength(1);
  });

  it("leaves a range whose lowest release is 4.6.6 or later, a range it cannot read, and a project without zod", async () => {
    await write("package.json", JSON.stringify({ name: "app", dependencies: { zod: "^4.6.6" }, devDependencies: { zod: "~4.7.1" } }));
    expect(await zodRangeRule.check(context())).toEqual([]);
    await write("package.json", JSON.stringify({ name: "app", dependencies: { zod: "catalog:" }, devDependencies: { zod: "latest" } }));
    expect(await zodRangeRule.check(context())).toEqual([]);
    await write("package.json", JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel": "^6.0.0" } }));
    expect(await zodRangeRule.check(context())).toEqual([]);
  });

  it("fires for a union whose lower branch is zod 3", async () => {
    await write("package.json", JSON.stringify({ name: "app", dependencies: { zod: "^3.23.8 || ^4.6.6" } }));
    expect(await zodRangeRule.check(context())).toHaveLength(1);
  });
});

describe("zod/record-key", () => {
  it("adds the string key schema to a one-argument record", async () => {
    const source = 'import { z } from "zod";\nexport const configSchema = z.object({ limits: z.record(z.number()) });\n';
    const file = await write("modules/custom/module.ts", source);
    const findings = await zodRecordKeyRule.check(context());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toEqual({ file });
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.docs).toBe(upgradingDocs("zod-record-key"));
    expect(applied(findings[0], source)).toBe('import { z } from "zod";\nexport const configSchema = z.object({ limits: z.record(z.string(), z.number()) });\n');
  });

  it("rewrites nested records and follows the local name of the zod import", async () => {
    const source = 'import * as schema from "zod";\nexport const nested = schema.record(schema.record(schema.unknown()));\n';
    await write("schemas.mts", source);
    const findings = await zodRecordKeyRule.check(context());
    expect(findings).toHaveLength(1);
    expect(applied(findings[0], source)).toContain("schema.record(schema.string(), schema.record(schema.string(), schema.unknown()))");
  });

  it("follows a renamed named import", async () => {
    const source = 'import { z as zod } from "zod";\nexport const tags = zod.record(zod.array(zod.string()));\n';
    await write("tags.ts", source);
    const findings = await zodRecordKeyRule.check(context());
    expect(applied(findings[0], source)).toContain("zod.record(zod.string(), zod.array(zod.string()))");
  });

  it("leaves a record that names its key, a record call on anything that is not zod, and a file without a zod import", async () => {
    await write("a.ts", 'import { z } from "zod";\nexport const a = z.record(z.string(), z.number());\n');
    await write("b.ts", 'import { z } from "zod";\nconst store = { record: (x: unknown) => x };\nexport const b = store.record(z.number());\n');
    await write("c.ts", "const z = { record: (x: unknown) => x };\nexport const c = z.record(1);\n");
    expect(await zodRecordKeyRule.check(context())).toEqual([]);
  });

  it("skips node_modules, dist and a file that does not parse", async () => {
    await write("node_modules/dep/index.ts", 'import { z } from "zod";\nexport const a = z.record(z.number());\n');
    await write("dist/module.js", 'import { z } from "zod";\nexport const a = z.record(z.number());\n');
    await write("broken.ts", 'import { z } from "zod";\nexport const a = z.record(z.number(;\n');
    expect(await zodRecordKeyRule.check(context())).toEqual([]);
  });
});

describe("zod/object-default", () => {
  it("turns the object-literal default of an object schema into a prefault", async () => {
    const source = 'import { z } from "zod";\nexport const configSchema = z.object({ limits: z.object({ max: z.number().default(5) }).strict().default({}) });\n';
    const file = await write("module.ts", source);
    const findings = await zodObjectDefaultRule.check(context());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toEqual({ file });
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.docs).toBe(upgradingDocs("zod-object-default"));
    expect(applied(findings[0], source)).toContain("z.object({ max: z.number().default(5) }).strict().prefault({})");
  });

  it("leaves scalar, array and record defaults and a default whose argument is not an object literal", async () => {
    const source = [
      'import { z } from "zod";',
      "const fallback = { max: 5 };",
      "export const a = z.object({",
      '  name: z.string().default("x"),',
      "  tags: z.array(z.string()).default([]),",
      "  labels: z.record(z.string(), z.string()).default({}),",
      "  limits: z.object({ max: z.number() }).default(fallback),",
      "});",
      "",
    ].join("\n");
    await write("module.ts", source);
    expect(await zodObjectDefaultRule.check(context())).toEqual([]);
  });
});

describe("zod/describe-order", () => {
  it("moves a .describe() that an object method follows to the end of the chain", async () => {
    const source = 'import { z } from "zod";\nexport const configSchema = z.object({ smtp: z.object({ host: z.string(), pass: z.string() }).describe("secret").strict() });\n';
    const file = await write("modules/mailer/module.ts", source);
    const findings = await zodDescribeOrderRule.check(context());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toEqual({ file });
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.docs).toBe(upgradingDocs("zod-describe-order"));
    expect(applied(findings[0], source)).toBe('import { z } from "zod";\nexport const configSchema = z.object({ smtp: z.object({ host: z.string(), pass: z.string() }).strict().describe("secret") });\n');
  });

  it("moves it past every object method that follows, on one line or across lines, and keeps a wrapper after it", async () => {
    const source = [
      'import { z } from "zod";',
      "const base = z.object({ user: z.string() });",
      'export const a = base.describe("secret").partial().passthrough().optional();',
      "export const b = z",
      "  .object({ user: z.string() })",
      '  .describe("Mail account")',
      "  .extend({ pass: z.string() })",
      "  .strict();",
      "",
    ].join("\n");
    await write("module.ts", source);
    const findings = await zodDescribeOrderRule.check(context());
    expect(findings).toHaveLength(1);
    const text = applied(findings[0], source);
    expect(text).toContain('export const a = base.partial().passthrough().describe("secret").optional();');
    expect(text).toContain('export const b = z\n  .object({ user: z.string() })\n  .extend({ pass: z.string() })\n  .strict().describe("Mail account");');
  });

  it("leaves a .describe() that is last or followed only by a wrapper, and a file without a zod import", async () => {
    await write("a.ts", 'import { z } from "zod";\nexport const a = z.object({ pass: z.string() }).strict().describe("secret").optional().default({ pass: "" });\n');
    await write("b.ts", 'const doc = { describe: (x: string) => ({ strict: () => x }) };\nexport const b = doc.describe("x").strict();\n');
    expect(await zodDescribeOrderRule.check(context())).toEqual([]);
  });
});

describe("the zod rules", () => {
  it("run with the default rules", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    for (const id of ["deps/zod-range", "zod/record-key", "zod/object-default", "zod/describe-order"]) expect(ids).toContain(id);
  });
});
