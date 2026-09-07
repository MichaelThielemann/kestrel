import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "rebuildLinks",
  steps: ["authn.requireUser", "authz.require:pages.manage", "links.rebuild"],
});
