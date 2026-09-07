import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "changePassword",
  steps: ["authn.requireUser", "authn.changePassword"],
});
