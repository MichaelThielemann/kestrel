import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StepDescription, StepManifest } from "../packages/core/src/index.ts";
import { brief, errors, inputCell, orderPackages, rootTable, splice, stepTable, ROOT_ORDER, type PackageInfo } from "./docs-render.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    expect(row).toBe("| `widget.ping` | Ping | – | – | – | – | – |");
  });

  it("renders a step's declared input in the Input column", () => {
    const step: StepManifest = { name: "widget.get", module: "widget/default", factory: false, description: { summary: "Get a widget", reads: ["widgets"], writes: [], input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } };
    const [, , row] = stepTable([step]);
    expect(row).toBe("| `widget.get` | Get a widget | `widgets` | – | { id: string } | – | – |");
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
  it("orders the four infrastructure packages first, then the rest alphabetically", () => {
    const packages: PackageInfo[] = [
      { name: "@michaelthielemann/kestrel-zeta", description: "z" },
      { name: "@michaelthielemann/kestrel-openapi", description: "openapi" },
      { name: "@michaelthielemann/kestrel-alpha", description: "a" },
      { name: "@michaelthielemann/kestrel-h3", description: "h3" },
      { name: "@michaelthielemann/kestrel", description: "core" },
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

  it("has 29 rows in the fixed-then-alphabetical order, against the real packages directory", () => {
    const ordered = orderPackages(realPackages());
    expect(ordered).toHaveLength(29);
    expect(ordered.slice(0, 4).map((p) => p.name)).toEqual(ROOT_ORDER);
    const rest = ordered.slice(4).map((p) => p.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
});
