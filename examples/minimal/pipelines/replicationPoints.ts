import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "replicationPoints",
  steps: ["authn.requireUser", "authz.require:system.manage", "replication.listPoints"],
});
