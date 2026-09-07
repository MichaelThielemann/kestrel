import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "syncImages",
  steps: ["authn.requireUser", "authz.require:images.manage", "images.sync"],
});
