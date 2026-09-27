import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listMigrations",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:migrations.manage", "migrations.list"],
});
