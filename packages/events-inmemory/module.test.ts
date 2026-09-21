import { describe, it, expect } from "vitest";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import module from "./module.ts";

describe("events/inmemory module", () => {
  it("registers no step and no event trigger hook", () => {
    expect("steps" in module).toBe(false);
    expect("triggers" in module).toBe(false);
  });

  it("does not provide events@1 as an object carrying a logger", async () => {
    const instance = await module.setup(module.configSchema.parse({}), {
      get: () => {
        throw new Error("no contract expected");
      },
      find: () => undefined,
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    });
    const events = boundaryCast<Events>(instance, "host");
    expect(typeof events.emit).toBe("function");
    expect(typeof events.on).toBe("function");
  });
});
