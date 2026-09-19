import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pruneAudit",
  steps: ["audit.prune"],
});
