import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "exportMedia",
  steps: ["authn.requireUser", "authz.require:media.manage", "media.export:./data/export", "images.export:./data/export"],
});
