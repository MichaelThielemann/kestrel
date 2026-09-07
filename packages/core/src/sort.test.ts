import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineContract, type Contract } from "./defineContract.ts";
import { defineModule } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";
import { sortModules } from "./sort.ts";

const C: Record<string, Contract<unknown>> = {};
const c = (name: string) => (C[name] ??= defineContract<{ x(): void }>()(name, ["x"]));
const mod = (name: string, provides: string[], requires: string[]) =>
  defineModule({ name, provides: provides.map(c), requires: requires.map(c), configSchema: z.object({}), setup: async () => ({}) });
const modOpt = (name: string, provides: string[], requires: string[], optional: string[]) =>
  defineModule({ name, provides: provides.map(c), requires: requires.map(c), optional: optional.map(c), configSchema: z.object({}), setup: async () => ({}) });

describe("sortModules", () => {
  it("puts providers before consumers", () => {
    const authn = mod("authn/multi", ["authn@1"], ["persistence@1"]);
    const db = mod("persistence/sqlite", ["persistence@1"], []);
    expect(sortModules([authn, db]).map((m) => m.name)).toEqual(["persistence/sqlite", "authn/multi"]);
  });

  it("reports a missing provider with module and contract", () => {
    const authn = mod("authn/multi", ["authn@1"], ["persistence@1"]);
    expect(() => sortModules([authn])).toThrow(new KestrelBootError("authn/multi", 'requires "persistence@1" but no active module provides it'));
  });

  it("reports duplicate providers", () => {
    expect(() => sortModules([mod("persistence/a", ["persistence@1"], []), mod("persistence/b", ["persistence@1"], [])])).toThrow(/already provided by persistence\/a/);
  });

  it("reports cycles", () => {
    const a = mod("a/x", ["authn@1"], ["authz@1"]);
    const b = mod("b/x", ["authz@1"], ["authn@1"]);
    expect(() => sortModules([a, b])).toThrow(/dependency cycle: a\/x -> b\/x -> a\/x/);
  });

  it("orders a module after the provider of an optional contract when it is loaded", () => {
    const cache = modOpt("cache/redis", ["cache@1"], [], []);
    const authn = modOpt("authn/multi", ["authn@1"], [], ["cache@1"]);
    expect(sortModules([authn, cache]).map((m) => m.name)).toEqual(["cache/redis", "authn/multi"]);
  });

  it("sorts fine when the optional provider is absent", () => {
    const authn = modOpt("authn/multi", ["authn@1"], [], ["cache@1"]);
    expect(sortModules([authn]).map((m) => m.name)).toEqual(["authn/multi"]);
  });

  it("optionally depending on a contract it provides itself is an error", () => {
    const authn = modOpt("authn/multi", ["authn@1"], [], ["authn@1"]);
    expect(() => sortModules([authn])).toThrow(new KestrelBootError("authn/multi", 'optional "authn@1" which it provides itself'));
  });
});
