import { defineStepSet } from "./stepSet.ts";

/** The five steps authn-single and authn-multi both register: login, identifyUser, requireUser, loadIdentity, logout. */
export const AUTHN_STEPS = defineStepSet({
  id: "authn",
  prefix: "authn",
  steps: ["authn.login", "authn.identifyUser", "authn.requireUser", "authn.loadIdentity", "authn.logout"],
});
