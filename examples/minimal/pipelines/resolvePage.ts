import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "resolvePage",
  steps: ["authn.identifyUser", "authz.require:pages.read", "redirects.lookup", "site.resolve:pages?home=home&status=published&fallback=true", "site.resolveLinks:pages?home=home&status=published&fallback=true"],
});
