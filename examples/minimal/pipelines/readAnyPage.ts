import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "readAnyPage",
  steps: ["authn.requireUser", "authz.require:pages.manage", "content.get:pages"],
});
