import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "cleanupSessions",
  steps: ["authn.cleanupSessions"],
});
