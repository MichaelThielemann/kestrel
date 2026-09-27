import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "replicationRestore",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:system.manage", "replication.prepareRestore"],
});
