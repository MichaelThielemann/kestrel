import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, loadConfig, loadModules, loadPipelines, silentLogger, type BootWarning, type StepDescription, type StepManifest } from "../packages/core/src/index.ts";
import { generateOpenApi } from "../packages/openapi/index.ts";
import { STEP_SETS } from "../packages/contracts/src/helpers/steps.ts";
import { brief, collectingLogger, errors, formatBootWarning, groupedArrowChain, inputCell, orderPackages, portabilityOf, rootTable, splice, stepTable, unexpectedBootWarnings, unexpectedLogEntries, ROOT_ORDER, type LogEntry, type PackageInfo } from "./docs-render.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "examples", "minimal");

function realPackages(): PackageInfo[] {
  return readdirSync(join(root, "packages"))
    .map((dir) => join(root, "packages", dir, "package.json"))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as PackageInfo);
}

describe("brief", () => {
  it("returns – for an undefined schema", () => {
    expect(brief(undefined)).toBe("–");
  });

  it("expands a top-level object's properties, marking required vs. optional", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"], additionalProperties: false };
    expect(brief(schema)).toBe("{ a: string, b?: number }");
  });

  it("collapses a nested object to `object` beyond the top level", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "object", properties: { c: { type: "string" } }, required: ["c"] } }, required: ["a"] };
    expect(brief(schema)).toBe("{ a: string, b?: object, … }");
  });

  it("applies the depth cut-off directly: an object schema below the top level is always `object`", () => {
    const schema = { type: "object", properties: { c: { type: "string" } }, required: ["c"] };
    expect(brief(schema, 1)).toBe("object");
  });

  it("joins oneOf branches with a pipe", () => {
    const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(brief(schema)).toBe("string | number");
  });
});

describe("inputCell", () => {
  it("renders the input schema alone", () => {
    const description: StepDescription = { summary: "s", reads: [], writes: [], input: { type: "string" } };
    expect(inputCell(description)).toBe("string");
  });

  it("renders query parameters alone, prefixed with ?", () => {
    const description: StepDescription = { summary: "s", reads: [], writes: [], query: { limit: { type: "number" } } };
    expect(inputCell(description)).toBe("?limit: number");
  });

  it("renders input and query together", () => {
    const description: StepDescription = { summary: "s", reads: [], writes: [], input: { type: "string" }, query: { limit: { type: "number" } } };
    expect(inputCell(description)).toBe("string ?limit: number");
  });

  it("returns – when neither input nor query is declared", () => {
    const description: StepDescription = { summary: "s", reads: [], writes: [] };
    expect(inputCell(description)).toBe("–");
  });
});

describe("errors", () => {
  it("joins status codes and messages with semicolons", () => {
    const description: StepDescription = { summary: "s", reads: [], writes: [], errors: { 404: "not found", 409: "conflict" } };
    expect(errors(description)).toBe("404 not found; 409 conflict");
  });

  it("returns an empty string when no errors are declared", () => {
    const description: StepDescription = { summary: "s", reads: [], writes: [] };
    expect(errors(description)).toBe("");
  });
});

describe("stepTable", () => {
  it("returns an empty array for no steps", () => {
    expect(stepTable([])).toEqual([]);
  });

  it("marks a factory step's name with :<arg>", () => {
    const step: StepManifest = { name: "widget.list", module: "widget/default", factory: true, description: { summary: "List widgets", reads: [], writes: [] } };
    const [, , row] = stepTable([step]);
    expect(row).toContain("`widget.list:<arg>`");
  });

  it("renders – in the Input column for a step without input or query", () => {
    const step: StepManifest = { name: "widget.ping", module: "widget/default", factory: false, description: { summary: "Ping", reads: [], writes: [] } };
    const [, , row] = stepTable([step]);
    expect(row).toBe("| `widget.ping` | Ping | – | – | – | – | – | – | no |");
  });

  it("renders a step's declared input in the Input column", () => {
    const step: StepManifest = { name: "widget.get", module: "widget/default", factory: false, description: { summary: "Get a widget", reads: ["widgets"], writes: [], input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } };
    const [, , row] = stepTable([step]);
    expect(row).toBe("| `widget.get` | Get a widget | `widgets` | – | { id: string } | – | – | – | no |");
  });

  it("marks a step declaring atomicSafe: true as yes in the Atomic-safe column", () => {
    const step: StepManifest = { name: "widget.create", module: "widget/default", factory: false, description: { summary: "Create a widget", reads: [], writes: ["result"], atomicSafe: true } };
    const [, , row] = stepTable([step]);
    expect(row).toBe("| `widget.create` | Create a widget | – | `result` | – | – | – | – | yes |");
  });

  it("appends ends: <brief> to the Output column for a step declaring terminalOutput", () => {
    const step: StepManifest = { name: "widget.stop", module: "widget/default", factory: false, description: { summary: "Maybe stop", reads: [], writes: ["result?"], terminalOutput: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false } } };
    const [, , row] = stepTable([step]);
    expect(row).toBe("| `widget.stop` | Maybe stop | – | `result?` | – | – (ends: { done: boolean }) | – | – | no |");
  });

  it("puts ends: <brief> next to the continuing output when both are declared", () => {
    const step: StepManifest = {
      name: "widget.upload",
      module: "widget/default",
      factory: false,
      description: {
        summary: "Upload",
        reads: [],
        writes: ["result"],
        output: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        terminalOutput: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      },
    };
    const [, , row] = stepTable([step]);
    expect(row).toBe("| `widget.upload` | Upload | – | `result` | – | { id: string } (ends: { id: string }) | – | – | no |");
  });
});

describe("groupedArrowChain", () => {
  interface Step {
    spec: string;
    atomic?: number;
  }
  const step = (spec: string, atomic?: number): Step => (atomic === undefined ? { spec } : { spec, atomic });

  it("renders a flat list unchanged", () => {
    const steps = [step("x"), step("x")];
    expect(groupedArrowChain(steps, (s) => s.spec)).toBe("x → x");
  });

  it("brackets consecutive steps sharing the same atomic ordinal", () => {
    const steps = [step("a"), step("b", 1), step("c", 1), step("d")];
    expect(groupedArrowChain(steps, (s) => s.spec)).toBe("a → [ b → c ] → d");
  });

  it("brackets a single-step group too", () => {
    const steps = [step("a", 1), step("b")];
    expect(groupedArrowChain(steps, (s) => s.spec)).toBe("[ a ] → b");
  });

  it("renders two separate groups as two brackets", () => {
    const steps = [step("a", 1), step("b", 1), step("c", 2)];
    expect(groupedArrowChain(steps, (s) => s.spec)).toBe("[ a → b ] → [ c ]");
  });
});

describe("splice", () => {
  const readme = "# Title\n\n<!-- kestrel-docs:start -->\nold\n<!-- kestrel-docs:end -->\n\nTail.\n";
  const generated = "<!-- kestrel-docs:start -->\nnew\n<!-- kestrel-docs:end -->";

  it("throws naming the file when the markers are missing", () => {
    expect(() => splice("# Title\nno markers here\n", generated, "packages/widget/README.md")).toThrow(/packages\/widget\/README\.md/);
  });

  it("replaces the content between existing markers", () => {
    expect(splice(readme, generated, "README.md")).toBe("# Title\n\n<!-- kestrel-docs:start -->\nnew\n<!-- kestrel-docs:end -->\n\nTail.\n");
  });

  it("is idempotent: splicing its own output again is a no-op", () => {
    const once = splice(readme, generated, "README.md");
    const twice = splice(once, generated, "README.md");
    expect(twice).toBe(once);
  });
});

describe("root package table", () => {
  it("orders the infrastructure packages first, then the rest alphabetically", () => {
    const packages: PackageInfo[] = [
      { name: "@michaelthielemann/kestrel-zeta", description: "z" },
      { name: "@michaelthielemann/kestrel-openapi", description: "openapi" },
      { name: "@michaelthielemann/kestrel-alpha", description: "a" },
      { name: "@michaelthielemann/kestrel-h3", description: "h3" },
      { name: "@michaelthielemann/kestrel", description: "core" },
      { name: "@michaelthielemann/kestrel-cli", description: "cli" },
      { name: "@michaelthielemann/kestrel-contracts", description: "contracts" },
    ];
    expect(orderPackages(packages).map((p) => p.name)).toEqual([...ROOT_ORDER, "@michaelthielemann/kestrel-alpha", "@michaelthielemann/kestrel-zeta"]);
  });

  it("throws when a required infrastructure package is missing", () => {
    const packages: PackageInfo[] = [{ name: "@michaelthielemann/kestrel-contracts", description: "contracts" }];
    expect(() => orderPackages(packages)).toThrow(/@michaelthielemann\/kestrel"/);
  });

  it("renders exactly one row per package", () => {
    const packages: PackageInfo[] = [
      { name: "@michaelthielemann/kestrel", description: "Core" },
      { name: "@michaelthielemann/kestrel-widget-default", description: "Steps widget.get/list" },
    ];
    const rows = rootTable(packages)
      .split("\n")
      .filter((line) => line.startsWith("| `"));
    expect(rows).toEqual(["| `@michaelthielemann/kestrel` | Core |", "| `@michaelthielemann/kestrel-widget-default` | Steps widget.get/list |"]);
  });

  it("has 35 rows in the fixed-then-alphabetical order, against the real packages directory", () => {
    const ordered = orderPackages(realPackages());
    expect(ordered).toHaveLength(35);
    expect(ordered.slice(0, ROOT_ORDER.length).map((p) => p.name)).toEqual(ROOT_ORDER);
    const rest = ordered.slice(ROOT_ORDER.length).map((p) => p.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
});

describe("unexpectedBootWarnings", () => {
  const unemitted: BootWarning = { code: "unemitted-event", message: "event trigger listens to an event no pipeline emits via events.emit and no module declares in emits", pipeline: "onCreated", event: "page.creted" };

  it("returns an empty array when boot produced no warnings", () => {
    expect(unexpectedBootWarnings([], [])).toEqual([]);
  });

  it("returns a warning that is not on the allowlist", () => {
    expect(unexpectedBootWarnings([unemitted], [])).toEqual([unemitted]);
  });

  it("accepts a warning that matches the allowlist by code, pipeline and event", () => {
    expect(unexpectedBootWarnings([unemitted], [unemitted])).toEqual([]);
  });

  it("still flags a warning whose pipeline or event differs from the allowlist entry", () => {
    const other: BootWarning = { ...unemitted, pipeline: "onOther" };
    expect(unexpectedBootWarnings([unemitted], [other])).toEqual([unemitted]);
  });
});

describe("formatBootWarning", () => {
  it("names the pipeline and the event", () => {
    const warning: BootWarning = { code: "unemitted-event", message: "event trigger listens to an event no pipeline emits via events.emit and no module declares in emits", pipeline: "onCreated", event: "page.creted" };
    expect(formatBootWarning(warning)).toBe('pipeline "onCreated", event "page.creted": event trigger listens to an event no pipeline emits via events.emit and no module declares in emits');
  });
});

describe("example config with an event trigger no pipeline emits", { timeout: 30_000 }, () => {
  it("makes the boot warning list non-empty, naming the pipeline and the event", async () => {
    const config = await loadConfig(join(example, "kestrel.config.ts"));
    const modules = await loadModules(example, config);
    const pipelines = await loadPipelines(example, config.pipelinesDir ?? "./pipelines");
    const withBadTrigger = { ...config, http: null, triggers: [...config.triggers, { event: "content.bogus", pipeline: "createPage" }] };
    const kestrel = await boot({ config: withBadTrigger, modules, pipelines, logger: silentLogger, root: example });
    const unexpected = unexpectedBootWarnings(kestrel.warnings, []);
    await kestrel.stop();
    expect(unexpected).toEqual([{ code: "unemitted-event", message: "event trigger listens to an event no pipeline emits via events.emit and no module declares in emits", pipeline: "createPage", event: "content.bogus" }]);
    expect(unexpected.map(formatBootWarning)).toEqual(['pipeline "createPage", event "content.bogus": event trigger listens to an event no pipeline emits via events.emit and no module declares in emits']);
  });
});

describe("example config's own steps", { timeout: 30_000 }, () => {
  it("generates the same OpenAPI document as the checked-in examples/minimal/openapi.json", async () => {
    const config = await loadConfig(join(example, "kestrel.config.ts"));
    const modules = await loadModules(example, config);
    const pipelines = await loadPipelines(example, config.pipelinesDir ?? "./pipelines");
    const kestrel = await boot({ config: { ...config, http: null }, modules, pipelines, logger: silentLogger, root: example });
    const pkg = JSON.parse(readFileSync(join(example, "package.json"), "utf8")) as { name?: string; version?: string };
    const generated = generateOpenApi(kestrel, { title: pkg.name ?? "Kestrel", version: pkg.version ?? "0.0.0", servers: ["http://127.0.0.1:4000"] });
    await kestrel.stop();
    const onDisk = JSON.parse(readFileSync(join(example, "openapi.json"), "utf8")) as unknown;
    expect(generated).toEqual(onDisk);
  });
});

describe("portabilityOf", () => {
  it("is total and unambiguous over every step of the example instance", async () => {
    const config = await loadConfig(join(example, "kestrel.config.ts"));
    const modules = await loadModules(example, config);
    const pipelines = await loadPipelines(example, config.pipelinesDir ?? "./pipelines");
    const kestrel = await boot({ config: { ...config, http: null }, modules, pipelines, logger: silentLogger, root: example });
    const names = kestrel.steps.names();
    await kestrel.stop();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(["portable", "beside", "none"]).toContain(portabilityOf(name));
  });

  it("marks authn.requireUser portable, authn.createUser beside, and content.create none", () => {
    expect(portabilityOf("authn.requireUser")).toBe("portable");
    expect(portabilityOf("authn.createUser")).toBe("beside");
    expect(portabilityOf("content.create")).toBe("none");
  });

  it("marks events.emit portable, matching EVENT_DELIVERY_STEPS", () => {
    const eventSet = STEP_SETS.find((s) => s.prefix === "events");
    expect(eventSet?.steps).toContain("events.emit");
    expect(portabilityOf("events.emit")).toBe("portable");
  });
});

describe("collectingLogger", () => {
  it("records a warn call with its message and data", () => {
    const entries: LogEntry[] = [];
    const logger = collectingLogger(entries);
    logger.warn?.("something odd", { pipeline: "p", event: "e" });
    expect(entries).toEqual([{ level: "warn", message: "something odd", data: { pipeline: "p", event: "e" } }]);
  });

  it("records info and error calls, and ignores step calls", () => {
    const entries: LogEntry[] = [];
    const logger = collectingLogger(entries);
    logger.info("hello");
    logger.error("boom");
    logger.step({ runId: "r", pipeline: "p", step: "s", ms: 1, outcome: "ok" });
    expect(entries).toEqual([{ level: "info", message: "hello" }, { level: "error", message: "boom" }]);
  });
});

describe("unexpectedLogEntries", () => {
  const unemitted: BootWarning = { code: "unemitted-event", message: "event trigger listens to an event no pipeline emits via events.emit and no module declares in emits", pipeline: "onCreated", event: "page.creted" };

  it("returns an empty array when there are no warn or error entries", () => {
    const entries: LogEntry[] = [{ level: "info", message: "hi" }];
    expect(unexpectedLogEntries(entries, [])).toEqual([]);
  });

  it("does not report a warn entry that matches a boot warning's message, pipeline and event", () => {
    const entries: LogEntry[] = [{ level: "warn", message: unemitted.message, data: { pipeline: unemitted.pipeline, event: unemitted.event } }];
    expect(unexpectedLogEntries(entries, [unemitted])).toEqual([]);
  });

  it("reports a warn entry that does not match any boot warning", () => {
    const entries: LogEntry[] = [{ level: "warn", message: "a module warned directly" }];
    expect(unexpectedLogEntries(entries, [])).toEqual(entries);
  });

  it("reports an error entry unconditionally", () => {
    const entries: LogEntry[] = [{ level: "error", message: "a module errored" }];
    expect(unexpectedLogEntries(entries, [])).toEqual(entries);
  });

  it("matches each boot warning to at most one log entry, so a leftover duplicate is still reported", () => {
    const entries: LogEntry[] = [
      { level: "warn", message: unemitted.message, data: { pipeline: unemitted.pipeline, event: unemitted.event } },
      { level: "warn", message: unemitted.message, data: { pipeline: unemitted.pipeline, event: unemitted.event } },
    ];
    expect(unexpectedLogEntries(entries, [unemitted])).toEqual([entries[1]]);
  });
});

describe("a module that logs a warning from setup() directly", () => {
  it("makes the boot's collected log entries flag that warning, not covered by kestrel.warnings", async () => {
    const warns = defineModule({
      name: "warns/setup",
      provides: [],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup(_config, deps): Promise<null> {
        deps.logger.warn?.("setup emitted a warning directly through the logger");
        return null;
      },
    });
    const entries: LogEntry[] = [];
    const kestrel = await boot({ config: { modules: [{ use: "./warns", config: {} }], triggers: [], http: null }, modules: [warns], pipelines: [], logger: collectingLogger(entries) });
    const unexpected = unexpectedLogEntries(entries, kestrel.warnings);
    await kestrel.stop();
    expect(unexpected).toEqual([{ level: "warn", message: "setup emitted a warning directly through the logger" }]);
  });
});
