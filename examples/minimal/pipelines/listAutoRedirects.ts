import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listAutoRedirects",
  steps: ["authn.requireUser", "authz.require:redirects.read", "redirects.listAuto"],
});
