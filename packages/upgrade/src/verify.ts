import { hasArrayHole, parseTs } from "./ast.ts";

/** Whether `text` (a file's content after applying edits) is still syntactically sound: valid JSON for a `.json` file, otherwise a TS/JS source with no array hole (`[a, , b]`) an edit can leave behind. An edit that fails this never gets written; the finding falls back to manual instead. */
export function verifiesAfterEdit(file: string, text: string): boolean {
  if (file.endsWith(".json")) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return !hasArrayHole(parseTs(text));
  } catch {
    return false;
  }
}
