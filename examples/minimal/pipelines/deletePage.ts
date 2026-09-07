import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deletePage",
  steps: ["authn.requireUser", "authz.require:pages.delete", "references.guard:pages", "content.remove:pages", "references.unindex:pages", "links.unextract:pages", "delivery.unpublish:pages", "delivery.exportLlms", "events.emit:page.deleted"],
});
