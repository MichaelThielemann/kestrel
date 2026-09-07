import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "createPage",
  steps: ["authn.requireUser", "authz.require:pages.write", "validate.check:pages.body", "validate.sanitize:pages.body", "validate.check:pages.body", "references.check:pages", "content.create:pages", "references.index:pages", "links.extract:pages", "delivery.publish:pages", "delivery.exportLlms", "events.emit:page.created"],
});
