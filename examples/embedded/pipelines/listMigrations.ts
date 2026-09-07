import { definePipeline } from "../modules.ts";

export default definePipeline({ name: "listMigrations", steps: ["migrations.list"] });
