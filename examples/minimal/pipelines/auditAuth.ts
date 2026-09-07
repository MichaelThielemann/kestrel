import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "auditAuth",
  steps: ["audit.record"],
});
