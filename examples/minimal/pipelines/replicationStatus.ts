import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "replicationStatus",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:system.manage", "replication.readStatus"],
});
