import { defineMigration, renameBlock } from "@michaelthielemann/kestrel-migrations-default/helpers";

export default defineMigration({
  id: "2026-09-03-text-to-prose",
  collection: "pages",
  up: ({ document }) => renameBlock(document, "text", "prose"),
});
