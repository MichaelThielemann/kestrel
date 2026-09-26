import type { FieldDefinition, FieldType } from "../persistence.ts";

export function fieldDefinition(value: FieldType | FieldDefinition): FieldDefinition {
  return typeof value === "string" ? { type: value } : value;
}
