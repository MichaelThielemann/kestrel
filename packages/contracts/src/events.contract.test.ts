import { describe, it, expect, beforeEach } from "vitest";
import type { Events, EventData } from "./events.ts";

export function eventsContractTests(make: () => Promise<Events>) {
  describe("events@1", () => {
    let bus: Events;
    beforeEach(async () => {
      bus = await make();
    });

    it("delivers name and data to a handler", async () => {
      const seen: Array<[string, EventData]> = [];
      bus.on("x.created", async (name, data) => {
        seen.push([name, data]);
      });
      await bus.emit("x.created", { id: "1" });
      expect(seen).toEqual([["x.created", { id: "1" }]]);
    });

    it("emit without handlers resolves", async () => {
      await expect(bus.emit("nobody.listens", {})).resolves.toBeUndefined();
    });

    it("only handlers of the emitted name run", async () => {
      let calls = 0;
      bus.on("a", async () => {
        calls++;
      });
      await bus.emit("b", {});
      expect(calls).toBe(0);
    });

    it("emit waits for async handlers", async () => {
      let done = false;
      bus.on("slow", async () => {
        await new Promise((r) => setTimeout(r, 5));
        done = true;
      });
      await bus.emit("slow", {});
      expect(done).toBe(true);
    });

    it("unsubscribe stops delivery", async () => {
      let calls = 0;
      const off = bus.on("a", async () => {
        calls++;
      });
      off();
      await bus.emit("a", {});
      expect(calls).toBe(0);
    });

    it("a throwing handler rejects emit", async () => {
      bus.on("boom", async () => {
        throw new Error("handler failed");
      });
      await expect(bus.emit("boom", {})).rejects.toThrow('events: 1 handler(s) failed for "boom"');
    });

    it("a throwing handler does not stop the next one, and emit aggregates both errors", async () => {
      let ranSecond = false;
      bus.on("boom", async () => {
        throw new Error("first");
      });
      bus.on("boom", async () => {
        ranSecond = true;
        throw new Error("second");
      });
      const error = await bus.emit("boom", {}).catch((e: unknown) => e);
      expect(ranSecond).toBe(true);
      expect(error).toBeInstanceOf(AggregateError);
      const agg = error as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect((agg.errors[0] as Error).message).toBe("first");
      expect((agg.errors[1] as Error).message).toBe("second");
    });

    it("handlers run in registration order, sequentially", async () => {
      const order: string[] = [];
      bus.on("seq", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("a-end");
      });
      bus.on("seq", async () => {
        order.push("b-start");
        order.push("b-end");
      });
      await bus.emit("seq", {});
      expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    });
  });
}
