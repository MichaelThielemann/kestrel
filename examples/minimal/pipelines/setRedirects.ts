import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "setRedirects",
  steps: ["authn.requireUser", "authz.require:redirects.write", "validate.check:redirects.rules", "redirects.validate", "content.set:redirects", "redirects.export"],
});
