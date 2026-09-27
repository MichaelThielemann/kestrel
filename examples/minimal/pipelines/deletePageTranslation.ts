import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deletePageTranslation",
  steps: [
    "authn.requireUser",
    "authz.requireRole",
    "authz.require:pages.write",
    { atomic: ["content.removeTranslation:pages", "revisions.removeTranslation:pages", "references.index:pages", "links.extract:pages", "site.indexPath:pages"] },
    "site.announcePaths",
    "events.emit:page.translationRemoved",
    "events.relay",
  ],
});
