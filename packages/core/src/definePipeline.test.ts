import { describe, expect, it } from "vitest";
import { boundaryCast } from "./cast.ts";
import { definePipeline, isAtomicGroup, pipelineSteps, type PipelineEntry } from "./definePipeline.ts";

describe("definePipeline", () => {
  it("rejects an empty name", () => {
    expect(() => definePipeline({ name: "", steps: ["a"] })).toThrow(/name must not be empty/);
  });

  it("rejects a pipeline with no steps", () => {
    expect(() => definePipeline({ name: "p", steps: [] })).toThrow(/pipeline "p" has no steps/);
  });

  it("accepts a flat pipeline", () => {
    const def = definePipeline({ name: "p", steps: ["a", "b"] });
    expect(def.steps).toEqual(["a", "b"]);
  });

  it("accepts an atomic group", () => {
    const def = definePipeline({ name: "p", steps: ["a", { atomic: ["b", "c"] }, "d"] });
    expect(def.steps).toEqual(["a", { atomic: ["b", "c"] }, "d"]);
  });

  it("rejects an empty atomic group", () => {
    expect(() => definePipeline({ name: "p", steps: [{ atomic: [] }] })).toThrow(
      /pipeline "p" has an empty atomic group/,
    );
  });

  it("rejects a pipeline whose only entry is an empty group as having no steps", () => {
    expect(() => definePipeline({ name: "p", steps: [{ atomic: [] }] })).toThrow(
      /has an empty atomic group/,
    );
  });

  it("rejects an atomic group inside an atomic group when it arrives as untyped JSON", () => {
    const steps = boundaryCast<readonly PipelineEntry[]>([{ atomic: [{ atomic: ["a"] }] }], "json");
    expect(() => definePipeline({ name: "p", steps })).toThrow(
      /pipeline "p" has an atomic group inside an atomic group/,
    );
  });

  it("rejects an entry that is neither a step name nor an atomic group", () => {
    const steps = boundaryCast<readonly PipelineEntry[]>([42], "json");
    expect(() => definePipeline({ name: "p", steps })).toThrow(
      /pipeline "p" entry 0 is neither a step name nor \{ atomic: \[\.\.\.\] \}/,
    );
  });
});

describe("isAtomicGroup", () => {
  it("distinguishes a step name from a group", () => {
    expect(isAtomicGroup("a")).toBe(false);
    expect(isAtomicGroup({ atomic: ["a"] })).toBe(true);
  });
});

describe("pipelineSteps", () => {
  it("flattens groups in order", () => {
    expect(pipelineSteps(["a", { atomic: ["b", "c"] }, "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("returns a flat list unchanged", () => {
    expect(pipelineSteps(["a", "b"])).toEqual(["a", "b"]);
  });
});
