import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({ name: "makeThing", steps: [{ atomic: ["things.create", "events.emit:thing.done"] }, "events.relay"] });
