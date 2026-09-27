import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "replicationSnapshot",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:system.manage", "replication.snapshot"],
});
