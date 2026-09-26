import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "restorePageRevision",
  steps: [
    "authn.requireUser",
    "authz.require:pages.write",
    "revisions.restore:pages",
    "validate.check:pages.body",
    "validate.sanitize:pages.body",
    "validate.check:pages.body",
    { atomic: ["references.check:pages", "content.update:pages", "revisions.record:pages", "references.index:pages", "links.extract:pages", "site.indexPath:pages"] },
    "site.announcePaths",
    "revisions.reportRestore",
    "events.emit:page.restored",
    "events.relay",
  ],
});
