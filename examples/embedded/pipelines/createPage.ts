import { definePipeline } from "../modules.ts";

export default definePipeline({ name: "createPage", steps: ["authn.requireUser", "authz.require:pages.write", "content.create:pages", "events.emit:page.created"] });
