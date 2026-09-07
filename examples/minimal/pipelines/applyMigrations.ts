import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "applyMigrations",
  steps: ["authn.requireUser", "authz.require:migrations.manage", "migrations.apply"],
});
