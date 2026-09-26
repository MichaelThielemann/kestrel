import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({ name: "onB", steps: ["things.note", "events.emit:thing.done"] });
