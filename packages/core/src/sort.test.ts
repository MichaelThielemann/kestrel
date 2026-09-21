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

  it("optionally depending on a contract it provides itself is an error", () => {
    const authn = modOpt("authn/multi", ["authn@1"], [], ["authn@1"]);
    expect(() => sortModules([authn])).toThrow(new KestrelBootError("authn/multi", 'optional "authn@1" which it provides itself'));
  });

  const hookMod = (name: string, provides: string[], requires: string[]) =>
    defineModule({ name, provides: provides.map(c), requires: requires.map(c), configSchema: z.object({}), setup: async () => ({}), triggers: { event: () => () => {} } });
  const emitter = (name: string, provides: string[], requires: string[]) =>
    defineModule({ name, provides: provides.map(c), requires: requires.map(c), configSchema: z.object({}), setup: async () => ({}), emits: ["x.happened"] });
  const restore = (name: string, requires: string[]) =>
    defineModule({ name, provides: [], requires: requires.map(c), configSchema: z.object({}), setup: async () => ({}) });

  it("the soft edge orders the queue before its emitter without moving the restore modules; fails without the edge and under the rejected entry-point variant", () => {
    const blobstore = mod("blobstore/filesystem", ["blobstore@1"], []);
    const replication = restore("replication/sqlite", ["blobstore@1"]);
    const persistence = mod("persistence/sqlite", ["persistence@1"], []);
    const bus = mod("events/inmemory", ["events@1"], []);
    const queue = hookMod("events/queue", [], ["persistence@1", "events@1"]);
    const migrations = emitter("migrations/default", [], ["persistence@1", "events@1"]);
    const order = sortModules([replication, persistence, blobstore, bus, migrations, queue]).map((m) => m.name);
    expect(order.indexOf("replication/sqlite")).toBeLessThan(order.indexOf("persistence/sqlite"));
    expect(order.indexOf("events/queue")).toBeLessThan(order.indexOf("migrations/default"));
  });

  it("the soft edge also holds when a consumer module pulls the emitter forward", () => {
    const persistence = mod("persistence/sqlite", ["persistence@1"], []);
    const bus = mod("events/inmemory", ["events@1"], []);
    const queue = hookMod("events/queue", [], ["persistence@1", "events@1"]);
    const migrations = emitter("migrations/default", ["migrations@1"], ["persistence@1", "events@1"]);
    const consumer = mod("consumer/fake", [], ["migrations@1"]);
    const order = sortModules([consumer, persistence, bus, queue, migrations]).map((m) => m.name);
    expect(order.indexOf("events/queue")).toBeLessThan(order.indexOf("migrations/default"));
    expect(order.at(-1)).toBe("consumer/fake");
  });

  it("cycles are still reported, through the hook module and elsewhere", () => {
    const hook = hookMod("hook/fake", ["a@1"], ["b@1"]);
    const other = emitter("other/fake", ["b@1"], ["a@1"]);
    expect(() => sortModules([hook, other])).toThrow(/dependency cycle:/);

    const x = mod("x/fake", ["c@1"], ["d@1"]);
    const y = mod("y/fake", ["d@1"], ["c@1"]);
    expect(() => sortModules([x, y])).toThrow(/dependency cycle:/);
  });

  it("a module list without an event-hook module sorts exactly as before the change", () => {
    const persistence = mod("persistence/sqlite", ["persistence@1"], []);
    const migrations = emitter("migrations/default", [], ["persistence@1"]);
    expect(sortModules([migrations, persistence]).map((m) => m.name)).toEqual(["persistence/sqlite", "migrations/default"]);
  });
});
