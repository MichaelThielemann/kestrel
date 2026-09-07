import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listAllPages",
  steps: ["authn.requireUser", "authz.require:pages.manage", "content.list:pages"],
});
