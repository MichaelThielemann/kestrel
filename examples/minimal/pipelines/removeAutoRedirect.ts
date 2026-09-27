import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "removeAutoRedirect",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:redirects.write", "redirects.removeAuto", "redirects.export"],
});
