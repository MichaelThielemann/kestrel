import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deletePage",
  steps: [
    "authn.requireUser",
    "authz.require:pages.delete",
    { atomic: ["references.guard:pages", "content.remove:pages", "revisions.remove:pages", "references.unindex:pages", "links.unextract:pages", "site.indexPath:pages"] },
    "site.announcePaths",
    "events.emit:page.deleted",
    "events.relay",
  ],
});
