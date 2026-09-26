import { AUTHN_STEPS } from "../authn.steps.ts";
import { EVENT_DELIVERY_STEPS } from "../events.steps.ts";
import { stepSets } from "./stepSet.ts";

/** Every declared step set; the single list a reader consults for the three-state portability marking. */
export const STEP_SETS = stepSets([AUTHN_STEPS, EVENT_DELIVERY_STEPS]);
