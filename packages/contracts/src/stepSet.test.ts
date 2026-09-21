import { describe, expect, it } from "vitest";
import { defineStepSet, stepSets } from "./stepSet.ts";

describe("defineStepSet", () => {
  it("accepts a valid set", () => {
    const set = defineStepSet({ id: "events.delivery", prefix: "events", steps: ["events.emit"] });
    expect(set).toEqual({ id: "events.delivery", prefix: "events", steps: ["events.emit"] });
  });

  it("rejects an empty steps list", () => {
    expect(() => defineStepSet({ id: "x", prefix: "x", steps: [] })).toThrow("declares no steps");
  });

  it("rejects a step that does not start with the prefix", () => {
    expect(() => defineStepSet({ id: "x", prefix: "x", steps: ["y.emit"] })).toThrow('does not start with "x."');
  });

  it("rejects a duplicate step entry", () => {
    expect(() => defineStepSet({ id: "x", prefix: "x", steps: ["x.a", "x.a"] })).toThrow('declares "x.a" twice');
  });

  it("rejects a bad id", () => {
    expect(() => defineStepSet({ id: "X", prefix: "x", steps: ["x.a"] })).toThrow("must look like");
  });

  it("rejects a bad prefix", () => {
    expect(() => defineStepSet({ id: "x", prefix: "X", steps: ["x.a"] })).toThrow("must look like");
  });
});

describe("stepSets", () => {
  it("rejects two sets that govern the same prefix", () => {
    const a = defineStepSet({ id: "a", prefix: "shared", steps: ["shared.one"] });
    const b = defineStepSet({ id: "b", prefix: "shared", steps: ["shared.two"] });
    expect(() => stepSets([a, b])).toThrow('both govern prefix "shared"');
  });

  it("accepts sets on distinct prefixes", () => {
    const a = defineStepSet({ id: "a", prefix: "one", steps: ["one.x"] });
    const b = defineStepSet({ id: "b", prefix: "two", steps: ["two.x"] });
    expect(stepSets([a, b])).toEqual([a, b]);
  });
});
