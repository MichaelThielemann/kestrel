import { describe, it, expect } from "vitest";
import { eventsContractTests } from "@michaelthielemann/kestrel-contracts/events.contract.test";
import type { EventData } from "@michaelthielemann/kestrel-contracts/events";
import { createEventsInmemory } from "./impl.ts";

eventsContractTests(async () => createEventsInmemory());

describe("events/inmemory", () => {
  it("delivers a frozen shallow copy of the emitted data, never the original object", async () => {
    const bus = createEventsInmemory();
    const nested = { tags: ["a"] };
    const data: EventData = { id: "1", nested };
    const received: EventData[] = [];
    bus.on("x", async (_name, d) => {
      received.push(d);
    });
    bus.on("x", async (_name, d) => {
      received.push(d);
    });
    await bus.emit("x", data);
    expect(received[0]).not.toBe(data);
    expect(received[0]).toBe(received[1]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(received[0]).toEqual(data);
    expect(received[0]?.nested).toBe(nested);
    expect(Object.isFrozen(nested)).toBe(false);
  });
});
