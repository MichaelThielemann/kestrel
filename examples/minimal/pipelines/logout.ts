import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "logout",
  steps: ["authn.requireUser", "authn.logout", "events.emit:auth.loggedOut"],
});
