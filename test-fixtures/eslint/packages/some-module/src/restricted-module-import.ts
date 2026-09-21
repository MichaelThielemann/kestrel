import "@michaelthielemann/kestrel-other-module";
import "h3";

declare const payload: unknown;
export const cast = payload as { id: string };
