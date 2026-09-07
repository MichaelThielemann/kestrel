import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import { customFailure, type KestrelError, type Result } from "./errors.ts";

export interface RenderInput {
  type: string;
  id: string;
  locale?: string;
  path: string;
  format: string;
  document: Record<string, unknown>;
}

export interface RenderAsset {
  path: string;
  data: Uint8Array | string;
  contentType: string;
}

export interface RenderOutput {
  data: Uint8Array | string;
  contentType: string;
  extension: string;
  assets?: RenderAsset[];
}

export type RendererCode = "TRANSIENT" | "RENDER_FAILED";
export type RendererError = KestrelError<RendererCode>;

/** The template or the host app rejected the document; `delivery-static` records it per locale instead of failing the request. */
export const renderFailed = (message: string, cause?: unknown): KestrelError<"RENDER_FAILED"> => customFailure("RENDER_FAILED", 500, message, cause === undefined ? {} : { cause });

export interface Renderer {
  formats(): string[];
  render(input: RenderInput): Promise<Result<RenderOutput, RendererError>>;
}

export const RENDERER = defineContract<Renderer>()("renderer@1", ["formats", "render"]);
