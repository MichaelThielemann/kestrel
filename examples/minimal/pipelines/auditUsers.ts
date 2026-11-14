import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "auditUsers",
  steps: ["audit.recordActor"],
});
