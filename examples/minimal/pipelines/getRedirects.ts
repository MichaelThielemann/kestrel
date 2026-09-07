import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "getRedirects",
  steps: ["authn.identifyUser", "authz.require:redirects.read", "content.get:redirects"],
});
