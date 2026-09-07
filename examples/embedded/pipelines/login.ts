import { definePipeline } from "../modules.ts";

export default definePipeline({ name: "login", steps: ["authn.login"] });
