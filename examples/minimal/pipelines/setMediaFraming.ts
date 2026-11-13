import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "setMediaFraming",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.write", "images.setFraming", "images.generate", "media.get", "images.attach", "authz.fields:media?shape=item"],
});
