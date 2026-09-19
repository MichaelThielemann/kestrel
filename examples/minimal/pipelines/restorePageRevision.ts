import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "restorePageRevision",
  steps: ["authn.requireUser", "authz.require:pages.write", "revisions.restore:pages", "validate.check:pages.body", "validate.sanitize:pages.body", "validate.check:pages.body", "references.check:pages", "content.update:pages", "revisions.record:pages", "references.index:pages", "links.extract:pages", "delivery.publish:pages", "delivery.exportLlms", "revisions.reportRestore", "events.emit:page.restored"],
});
