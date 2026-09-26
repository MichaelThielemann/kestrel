import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "previewPagePath",
  steps: ["authn.requireUser", "authz.require:pages.write", "site.previewPath:pages"],
});
