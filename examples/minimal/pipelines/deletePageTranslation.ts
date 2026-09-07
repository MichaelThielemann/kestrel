import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deletePageTranslation",
  steps: ["authn.requireUser", "authz.require:pages.write", "content.removeTranslation:pages", "references.index:pages", "links.extract:pages", "delivery.publish:pages", "delivery.exportLlms", "events.emit:page.translationRemoved"],
});
