import { definePipeline } from "../modules.ts";

export default definePipeline({ name: "countPages", steps: ["content.list:pages"] });
