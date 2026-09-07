import { failure, type KestrelError } from "@michaelthielemann/kestrel/errors";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import { z } from "zod";

export type SizeSource = "default" | "config" | "registered";

export interface SizeRow extends Size {
  source: SizeSource;
  updatedAt: number;
}

export const DEFAULT_SIZES: Size[] = [
  { name: "thumb", width: 320, fit: "inside", format: "webp", quality: 82 },
  { name: "small", width: 640, fit: "inside", format: "webp", quality: 82 },
  { name: "medium", width: 1024, fit: "inside", format: "webp", quality: 82 },
  { name: "large", width: 1600, fit: "inside", format: "webp", quality: 82 },
  { name: "xl", width: 2400, fit: "inside", format: "webp", quality: 82 },
];

export const sizeSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192).optional(),
    fit: z.enum(["inside", "cover"]).default("inside"),
    format: z.enum(["webp", "original"]).default("webp"),
    quality: z.number().int().min(1).max(100).default(82),
  })
  .superRefine((size, ctx) => {
    if (size.fit === "cover" && size.height === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "height is required for fit \"cover\"", path: ["height"] });
    }
  });

export type Size = z.output<typeof sizeSchema>;

export function spec(size: Size): string {
  return `${size.width}x${size.height ?? ""}:${size.fit}:${size.format}:${size.quality}`;
}

const EXT_ALIASES: Record<string, string> = { jpeg: "jpg" };

export function extOf(size: Size, originalFormat: string): string {
  if (size.format === "webp") return "webp";
  return EXT_ALIASES[originalFormat] ?? originalFormat;
}

export function mergeSizes(base: Size[], baseSource: "default" | "config", registered: Size[]): Result<SizeRow[], KestrelError<"CONFLICT">> {
  const now = Date.now();
  const rows = new Map<string, SizeRow>();
  for (const size of base) rows.set(size.name, { ...size, source: baseSource, updatedAt: now });
  for (const size of registered) {
    const existing = rows.get(size.name);
    if (baseSource === "config" && existing?.source === "config" && spec(existing) !== spec(size)) {
      return err(failure("CONFLICT", `images: size "${size.name}" is defined in config`));
    }
    rows.set(size.name, { ...size, source: "registered", updatedAt: now });
  }
  return ok([...rows.values()]);
}
