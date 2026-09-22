import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineContract, type Contract } from "./defineContract.ts";
import { defineModule } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";
import { sortModules } from "./sort.ts";

const C: Record<string, Contract<unknown>> = {};
const c = (name: string) => (C[name] ??= defineContract<{ x(): void }>()(name, ["x"]));

function mod(name: string, options: { provides?: string[]; requires?: string[]; optional?: string[]; before?: string[]; emits?: string[]; hook?: boolean } = {}) {
  return defineModule({
    name,
    provides: (options.provides ?? []).map(c),
    requires: (options.requires ?? []).map(c),
    optional: (options.optional ?? []).map(c),
    before: (options.before ?? []).map(c),
    ...(options.emits ? { emits: options.emits } : {}),
    ...(options.hook ? { triggers: { event: () => () => {} } } : {}),
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

  it("rule 3: before sets the declarer up ahead of the provider it names, listed order notwithstanding", () => {
    const restore = mod("restore/r", { before: ["db@1"] });
    const provider = mod("db/store", { provides: ["db@1"] });
    expect(sortModules([provider, restore]).map((m) => m.name)).toEqual(["restore/r", "db/store"]);
  });

  it("rule 3: has no effect when the declarer is already listed before the provider", () => {
    const restore = mod("restore/r", { before: ["db@1"] });
    const provider = mod("db/store", { provides: ["db@1"] });
    expect(sortModules([restore, provider]).map((m) => m.name)).toEqual(["restore/r", "db/store"]);
  });

  it("rule 3: has no effect when the named contract has no active provider", () => {
    const restore = mod("restore/r", { before: ["db@1"] });
    expect(sortModules([restore]).map((m) => m.name)).toEqual(["restore/r"]);
  });

  it("rule 3: declaring before and requires on the same contract is a contradiction, not a reorder", () => {
    const contradictory = mod("consumer/one", { requires: ["db@1"], before: ["db@1"] });
    expect(() => sortModules([contradictory])).toThrow(new KestrelBootError("consumer/one", 'declares before "db@1" and requires "db@1"; a module cannot require what it must be set up before'));
  });

  it("rule 3: a provider that depends on the declaring module transitively is a dependency cycle, reported with its path", () => {
    const persistence = mod("persistence/sqlite", { provides: ["persistence@1"] });
    const blobstore = mod("blobstore/objectstore", { provides: ["blobstore@1"], requires: ["persistence@1"] });
    const replication = mod("replication/sqlite", { requires: ["blobstore@1"], before: ["persistence@1"] });
    expect(() => sortModules([persistence, blobstore, replication])).toThrow(
      new KestrelBootError("persistence/sqlite", "dependency cycle: persistence/sqlite -> replication/sqlite -> blobstore/objectstore -> persistence/sqlite"),
    );
  });

  it("rule 4: a module declaring emits is set up after the module providing the event trigger hook, unless that module depends on it", () => {
    const persistence = mod("persistence/sqlite", { provides: ["persistence@1"] });
    const bus = mod("events/inmemory", { provides: ["events@1"] });
    const queue = mod("events/queue", { requires: ["persistence@1", "events@1"], hook: true });
    const migrations = mod("migrations/default", { requires: ["persistence@1", "events@1"], emits: ["migrations.applied"] });
    const order = sortModules([migrations, queue, bus, persistence]).map((m) => m.name);
    expect(order.indexOf("events/queue")).toBeLessThan(order.indexOf("migrations/default"));
  });

  it("rule 4: the soft edge holds even when a consumer of the emitter pulls it forward", () => {
    const persistence = mod("persistence/sqlite", { provides: ["persistence@1"] });
    const bus = mod("events/inmemory", { provides: ["events@1"] });
    const queue = mod("events/queue", { requires: ["persistence@1", "events@1"], hook: true });
    const migrations = mod("migrations/default", { provides: ["migrations@1"], requires: ["persistence@1", "events@1"], emits: ["migrations.applied"] });
    const consumer = mod("consumer/fake", { requires: ["migrations@1"] });
    const order = sortModules([consumer, persistence, bus, queue, migrations]).map((m) => m.name);
    expect(order.indexOf("events/queue")).toBeLessThan(order.indexOf("migrations/default"));
    expect(order.at(-1)).toBe("consumer/fake");
  });

  it("rule 5: otherwise the listed order is kept", () => {
    const a = mod("a/one");
    const b = mod("b/two");
    expect(sortModules([b, a]).map((m) => m.name)).toEqual(["b/two", "a/one"]);
  });

  it("rules 1-4 pinned together: a wrongly listed backup chain is still sorted safely", () => {
    const blobstore = mod("blobstore/filesystem", { provides: ["blobstore@1"] });
    const replication = mod("replication/sqlite", { requires: ["blobstore@1"], before: ["persistence@1"] });
    const persistence = mod("persistence/sqlite", { provides: ["persistence@1"] });
    const bus = mod("events/inmemory", { provides: ["events@1"] });
    const queue = mod("events/queue", { requires: ["persistence@1", "events@1"], hook: true });
    const migrations = mod("migrations/default", { requires: ["persistence@1", "events@1"], emits: ["migrations.applied"] });

    const order = sortModules([blobstore, migrations, queue, replication, persistence, bus]).map((m) => m.name);
    expect(order.indexOf("replication/sqlite")).toBeLessThan(order.indexOf("persistence/sqlite"));
    expect(order.indexOf("events/queue")).toBeLessThan(order.indexOf("migrations/default"));
  });

  it("a consumer blobstore requiring persistence, with replication declaring before persistence, cannot be made to work", () => {
    const persistence = mod("persistence/sqlite", { provides: ["persistence@1"] });
    const blobstore = mod("blobstore/objectstore", { provides: ["blobstore@1"], requires: ["persistence@1"] });
    const replication = mod("replication/sqlite", { requires: ["blobstore@1"], before: ["persistence@1"] });
    expect(() => sortModules([blobstore, replication, persistence])).toThrow(
      new KestrelBootError("blobstore/objectstore", "dependency cycle: blobstore/objectstore -> persistence/sqlite -> replication/sqlite -> blobstore/objectstore"),
    );
  });
});
