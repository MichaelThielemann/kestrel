import { definePipeline } from "../modules.ts";

export default definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home&status=published&fallback=true"] });
