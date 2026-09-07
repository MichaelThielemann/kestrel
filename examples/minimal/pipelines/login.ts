import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "login",
  steps: ["ratelimit.check:login", "authn.login", "events.emit:auth.loggedIn"],
});
