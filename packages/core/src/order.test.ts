import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineContract, type Contract } from "./defineContract.ts";
import { defineModule } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";
import { findModuleOrderViolations, sortModules } from "./sort.ts";

const C: Record<string, Contract<unknown>> = {};
const c = (name: string) => (C[name] ??= defineContract<{ x(): void }>()(name, ["x"]));

function mod(name: string, options: { provides?: string[]; requires?: string[]; optional?: string[]; before?: string[] } = {}) {
  return defineModule({
    name,
    provides: (options.provides ?? []).map(c),
    requires: (options.requires ?? []).map(c),
    optional: (options.optional ?? []).map(c),
    before: (options.before ?? []).map(c),
    configSchema: z.object({}),
    setup: async () => ({}),
  });
}

describe("module setup order", () => {
  it("rule 1: a module is set up after the provider of every contract in requires", () => {
    const consumer = mod("consumer/one", { requires: ["db@1"] });
    const provider = mod("db/store", { provides: ["db@1"] });
    expect(sortModules([consumer, provider]).map((m) => m.name)).toEqual(["db/store", "consumer/one"]);
  });

  it("rule 2: a module is set up after the provider of an active optional contract", () => {
    const consumer = mod("consumer/two", { optional: ["cache@1"] });
    const provider = mod("cache/redis", { provides: ["cache@1"] });
    expect(sortModules([consumer, provider]).map((m) => m.name)).toEqual(["cache/redis", "consumer/two"]);
  });

  it("rule 2: an absent optional provider does not block sorting", () => {
    const consumer = mod("consumer/two", { optional: ["cache@1"] });
    expect(sortModules([consumer]).map((m) => m.name)).toEqual(["consumer/two"]);
  });

  it("rule 3: before is checked but does not reorder on this line — a violation is reported, not fixed", () => {
    const restore = mod("restore/r", { before: ["db@1"] });
    const provider = mod("db/store", { provides: ["db@1"] });
    const sorted = sortModules([provider, restore]);
    expect(sorted.map((m) => m.name)).toEqual(["db/store", "restore/r"]);
    expect(findModuleOrderViolations(sorted)).toEqual([{ module: "restore/r", contract: "db@1", provider: "db/store" }]);
  });

  it("rule 3: no violation when the declarer is already listed before the provider", () => {
    const restore = mod("restore/r", { before: ["db@1"] });
    const provider = mod("db/store", { provides: ["db@1"] });
    const sorted = sortModules([restore, provider]);
    expect(sorted.map((m) => m.name)).toEqual(["restore/r", "db/store"]);
    expect(findModuleOrderViolations(sorted)).toEqual([]);
  });

  it("rule 3: no violation when the named contract has no active provider", () => {
    const restore = mod("restore/r", { before: ["db@1"] });
    expect(findModuleOrderViolations(sortModules([restore]))).toEqual([]);
  });

  it("rule 5: otherwise the listed order is kept", () => {
    const a = mod("a/one");
    const b = mod("b/two");
    expect(sortModules([b, a]).map((m) => m.name)).toEqual(["b/two", "a/one"]);
  });

  it("rule 3: declaring before and requires on the same contract is a contradiction, not a warning", () => {
    const contradictory = mod("consumer/one", { requires: ["db@1"], before: ["db@1"] });
    expect(() => sortModules([contradictory])).toThrow(new KestrelBootError("consumer/one", 'declares before "db@1" and requires "db@1"; a module cannot require what it must be set up before'));
  });

  it("rules 1, 2 and 3 combined: a required provider is pulled ahead of a before-declaring module that has no edge to it", () => {
    const provider = mod("db/store", { provides: ["db@1"] });
    const consumer = mod("consumer/one", { requires: ["db@1"] });
    const restore = mod("restore/r", { before: ["db@1"] });
    const sorted = sortModules([consumer, restore, provider]);
    expect(sorted.map((m) => m.name)).toEqual(["db/store", "consumer/one", "restore/r"]);
    expect(findModuleOrderViolations(sorted)).toEqual([{ module: "restore/r", contract: "db@1", provider: "db/store" }]);
  });
});
