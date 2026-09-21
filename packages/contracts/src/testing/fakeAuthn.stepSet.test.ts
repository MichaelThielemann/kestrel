import { describe, expect, it } from "vitest";
import { AUTHN_STEPS } from "../authn.steps.ts";
import { FAKE_AUTHN_WRITES, fakeAuthnSteps, createAuthnFake } from "./fakeAuthn.ts";

describe("AUTHN_STEPS against the fake", () => {
  it("the fake declares exactly the steps of the set", () => {
    expect(new Set(Object.keys(FAKE_AUTHN_WRITES))).toEqual(new Set(AUTHN_STEPS.steps));
  });

  it("fakeAuthnSteps() registers exactly the steps of the set", () => {
    const steps = fakeAuthnSteps(createAuthnFake());
    expect(new Set(Object.keys(steps))).toEqual(new Set(AUTHN_STEPS.steps));
  });
});
