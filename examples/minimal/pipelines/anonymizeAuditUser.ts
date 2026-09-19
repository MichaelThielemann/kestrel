import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "anonymizeAuditUser",
  steps: ["audit.anonymize"],
});
