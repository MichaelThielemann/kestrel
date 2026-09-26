import { customFailure } from "../errors.ts";
import type { KestrelError } from "../errors.ts";

/** The template or the host app rejected the document; `delivery-static` records it per locale instead of failing the request. */
export const renderFailed = (message: string, cause?: unknown): KestrelError<"RENDER_FAILED"> => customFailure("RENDER_FAILED", 500, message, cause === undefined ? {} : { cause });
