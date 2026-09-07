import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "createUser",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.createUser", "events.emit:user.created"],
});
