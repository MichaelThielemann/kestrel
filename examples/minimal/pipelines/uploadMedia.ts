import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "uploadMedia",
  steps: ["authn.requireUser", "authz.require:media.write", "sanitize.svg", "media.upload", "events.emit:media.uploaded"],
});
