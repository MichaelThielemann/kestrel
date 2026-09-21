import { authnStepsContractTests } from "../authn.steps.contract.test.ts";
import { createAuthnFake, fakeAuthnSteps, FAKE_AUTHN_WRITES } from "./fakeAuthn.ts";

authnStepsContractTests(async () => ({
  steps: fakeAuthnSteps(createAuthnFake("alice", "long-enough")),
  writes: FAKE_AUTHN_WRITES,
  writesByStep: FAKE_AUTHN_WRITES,
  credentials: { username: "alice", password: "long-enough" },
}));
