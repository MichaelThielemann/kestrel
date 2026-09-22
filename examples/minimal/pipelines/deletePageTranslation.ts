import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deletePageTranslation",
  steps: [
    "authn.requireUser",
    "authz.require:pages.write",
    { atomic: ["content.removeTranslation:pages", "revisions.removeTranslation:pages", "references.index:pages", "links.extract:pages"] },
    "events.emit:page.translationRemoved",
    "events.relay",
  ],
});
