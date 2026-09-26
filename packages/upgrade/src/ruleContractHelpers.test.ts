import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootCheck } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { contractHelperImportsRule } from "./ruleContractHelpers.ts";
import { readFileOrUndefined } from "./rules.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-contract-helpers-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function bootCheck(): BootCheck {
  return { errors: [], warnings: [], notChecked: [] };
}

function project(options: { moduleFiles?: Record<string, string>; pipelineFiles?: Array<{ file: string; pipelines: string[] }> } = {}): LoadedProject {
  const configFile = join(dir, "kestrel.config.ts");
  return {
    input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(options.moduleFiles ?? {})),
    pipelineFiles: options.pipelineFiles ?? [],
  };
}

function contextFor(p: LoadedProject): RuleContext {
  return { root: dir, scratch: dir, project: p, bootCheck: bootCheck(), readFile: readFileOrUndefined, answers: new Map() };
}

async function write(relPath: string, content: string): Promise<string> {
  const file = join(dir, relPath);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
  return file;
}

describe("imports/contract-helpers: wholesale helper moves", () => {
  it("does not fire for a module without a moved import", async () => {
    const file = await write("custom.ts", 'import { ok } from "@michaelthielemann/kestrel-contracts/errors";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    expect(await contractHelperImportsRule.check(contextFor(p))).toEqual([]);
  });

  it("rewrites a moved helper import in a local module file", async () => {
    const file = await write("custom.ts", 'import { mediaTypeAllowed } from "@michaelthielemann/kestrel-contracts/mediaType";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('from "@michaelthielemann/kestrel-contracts/helpers/mediaType"');
  });

  it("rewrites more than one moved helper import in the same file, in one finding", async () => {
    const file = await write(
      "custom.ts",
      ['import { publishedLocale } from "@michaelthielemann/kestrel-contracts/content-locale";', 'import { ownedPersistence } from "@michaelthielemann/kestrel-contracts/persistence.owned";', 'export default defineModule({ name: "custom/module" });', ""].join("\n"),
    );
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("content-locale");
    expect(findings[0]?.message).toContain("persistence.owned");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('from "@michaelthielemann/kestrel-contracts/helpers/content-locale"');
    expect(text).toContain('from "@michaelthielemann/kestrel-contracts/helpers/persistence.owned"');
  });

  it("rewrites a moved helper import in kestrel.config.ts itself", async () => {
    const p = project();
    await writeFile(p.configFile, 'import { documentSchema } from "@michaelthielemann/kestrel-contracts/content-schema";\nexport default defineConfig({ modules: [] });\n');
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(p.configFile)!, edits);
    expect(text).toContain('from "@michaelthielemann/kestrel-contracts/helpers/content-schema"');
  });

  it("rewrites a moved helper import in a pipeline file", async () => {
    const file = await write("pipelines/onNoteCreated.ts", 'import { eventEnvelope } from "@michaelthielemann/kestrel-contracts/events.envelope";\ndefinePipeline({ name: "onNoteCreated", steps: [] });\n');
    const p = project({ pipelineFiles: [{ file, pipelines: ["onNoteCreated"] }] });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('from "@michaelthielemann/kestrel-contracts/helpers/events.envelope"');
  });
});

describe("imports/contract-helpers: M1 file scope", () => {
  it("finds a moved import in a file transitively reached from module.ts, not itself a module/pipeline file", async () => {
    const moduleFile = await write("custom/module.ts", 'export { default } from "./impl.ts";\n');
    await write("custom/impl.ts", 'import { mediaTypeAllowed } from "@michaelthielemann/kestrel-contracts/mediaType";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": moduleFile } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    const implFinding = findings.find((f) => f.where.file?.endsWith("impl.ts"));
    expect(implFinding).toBeDefined();
    expect(implFinding?.fix.kind).toBe("auto");
  });

  it("never reports a finding for a file reached through node_modules", async () => {
    const file = await write(
      "node_modules/@michaelthielemann/kestrel-images-default/module.js",
      'import { mediaTypeAllowed } from "@michaelthielemann/kestrel-contracts/mediaType";\nexport default { name: "images/default" };\n',
    );
    const p = project({ moduleFiles: { "@michaelthielemann/kestrel-images-default": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toEqual([]);
  });
});

describe("imports/contract-helpers: M2 mixed old paths, splitting an import when needed", () => {
  it("splits a mixed import from events.steps into a frozen-surface import and a helpers/events.envelope import", async () => {
    const file = await write("custom.ts", 'import { DELIVERY_STATUS_SCHEMA, mergeRelayReport, relaySummary, RELAY_SCHEMA } from "@michaelthielemann/kestrel-contracts/events.steps";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('import { DELIVERY_STATUS_SCHEMA, RELAY_SCHEMA } from "@michaelthielemann/kestrel-contracts/events.steps";');
    expect(text).toContain('import { mergeRelayReport, relaySummary } from "@michaelthielemann/kestrel-contracts/helpers/events.envelope";');
  });

  it("leaves an events.steps import alone when every name stays frozen", async () => {
    const file = await write("custom.ts", 'import { EVENT_DELIVERY_STEPS, type DeliveryStatus } from "@michaelthielemann/kestrel-contracts/events.steps";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    expect(await contractHelperImportsRule.check(contextFor(p))).toEqual([]);
  });

  it("splits a mixed import from links into an unchanged frozen import and a helpers/links import", async () => {
    const file = await write("custom.ts", 'import { INTERNAL_REF, collectInternalRefs } from "@michaelthielemann/kestrel-contracts/links";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('import { INTERNAL_REF } from "@michaelthielemann/kestrel-contracts/links";');
    expect(text).toContain('import { collectInternalRefs } from "@michaelthielemann/kestrel-contracts/helpers/links";');
  });

  it("rewrites a links import in place when every name it holds moves", async () => {
    const file = await write("custom.ts", 'import { collectInternalRefs } from "@michaelthielemann/kestrel-contracts/links";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('import { collectInternalRefs } from "@michaelthielemann/kestrel-contracts/helpers/links";');
  });

  it("moves a stepSet function import to helpers/stepSet but leaves the StepSet type import alone", async () => {
    const file = await write(
      "custom.ts",
      ['import { defineStepSet } from "@michaelthielemann/kestrel-contracts/stepSet";', 'import type { StepSet } from "@michaelthielemann/kestrel-contracts/stepSet";', "export default defineModule({ name: \"custom/module\" });", ""].join("\n"),
    );
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('import { defineStepSet } from "@michaelthielemann/kestrel-contracts/helpers/stepSet";');
    expect(text).toContain('import type { StepSet } from "@michaelthielemann/kestrel-contracts/stepSet";');
  });

  it("splits a single mixed declaration importing both a moved function and the untouched StepSet type", async () => {
    const file = await write("custom.ts", 'import { defineStepSet, type StepSet } from "@michaelthielemann/kestrel-contracts/stepSet";\nexport default defineModule({ name: "custom/module" });\n');
    const p = project({ moduleFiles: { "custom/module": file } });
    const findings = await contractHelperImportsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(file)!, edits);
    expect(text).toContain('import { defineStepSet } from "@michaelthielemann/kestrel-contracts/helpers/stepSet";');
    expect(text).toContain('import { type StepSet } from "@michaelthielemann/kestrel-contracts/stepSet";');
  });
});
