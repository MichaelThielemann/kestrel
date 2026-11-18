import type { Schema } from "@michaelthielemann/kestrel-contracts/persistence";

export const SIZES = "images_sizes";
export const VARIANTS = "images_variants";
export const JOBS = "images_jobs";
export const RETIRED = "images_retired";
export const HIDDEN = "images_hidden";
export const FRAMING = "images_framing";
export const ITEMS = "images_items";

/** The schema of {@link VARIANTS} this release reads and writes. */
export const VARIANTS_SCHEMA: Schema = { mediaId: "string", size: "string", slot: { type: "string", unique: true }, spec: "string", width: "number", height: "number", format: "string", key: "string", bytes: "number", state: "string", error: "json", attempts: "number", updatedAt: "number", crop: "string", renderedCrop: "string", renders: "number", originalWidth: "number", originalHeight: "number" };

/** The schema of {@link RETIRED} this release reads and writes. */
export const RETIRED_SCHEMA: Schema = { mediaId: "string", file: "string", slot: { type: "string", unique: true }, retiredAt: "number" };

/** Every collection this module stores; the persistence handle it is given reaches these and no other. */
export const COLLECTIONS: readonly string[] = [SIZES, VARIANTS, JOBS, RETIRED, HIDDEN, FRAMING, ITEMS];
