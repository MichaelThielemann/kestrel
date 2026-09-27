import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "createPage",
  steps: [
    "authn.requireUser",
    "authz.requireRole",
    "authz.require:pages.write",
    "validate.check:pages.body",
    "validate.sanitize:pages.body",
    "validate.check:pages.body",
    { atomic: ["references.check:pages", "content.create:pages", "revisions.record:pages", "references.index:pages", "links.extract:pages", "site.indexPath:pages"] },
    "site.announcePaths",
    "events.emit:page.created",
    "events.relay",
  ],
});
