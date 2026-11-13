export interface TestDisposition {
  kind: "test";
  file: string;
  title: string;
}

export interface WaiverDisposition {
  kind: "waiver";
  reason: string;
  /** A step name (e.g. "authn.requireUser") an example pipeline using this candidate must run first. */
  upstream?: string;
}

export type ObjectBindingDisposition = TestDisposition | WaiverDisposition;

function key(module: string, step: string): string {
  return `${module}#${step}`;
}

export const OBJECT_BINDING_REGISTRY: Record<string, ObjectBindingDisposition> = {
  [key("audit/persistence", "anonymize")]: { kind: "waiver", reason: "params.id names the only user this step acts on; there is no second object to bind to." },
  [key("authn/multi", "updateUser")]: { kind: "waiver", reason: "params.id names the only user this step acts on; there is no second object to bind to." },
  [key("mfa/totp", "forget")]: { kind: "waiver", reason: "params.id or the event payload's id names the only user this step acts on; there is no second object to bind to." },
  [key("authn/multi", "setPassword")]: { kind: "waiver", reason: "params.id names the only user this step acts on; there is no second object to bind to." },
  [key("authn/multi", "deleteUser")]: { kind: "test", file: "authn-multi/module.test.ts", title: "deleteUser keeps the user when the reassign target is unknown, inactive, themselves or not an id" },

  [key("content/default", "get")]: { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  [key("content/default", "update")]: { kind: "waiver", reason: "the input schema is the document's own fields; a reference to another document is validated by references-default, not by content itself." },
  [key("content/default", "removeTranslation")]: { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },

  [key("delivery/static", "unpublish")]: { kind: "waiver", reason: "payload.id is only a fallback used when params.id is absent, in an event-triggered run with no HTTP caller; params.id remains the resource itself, not a second object to bind to." },

  [key("images/default", "serve")]: { kind: "test", file: "images-default/module.test.ts", title: "serve: does not return another media item's variant for the same size name" },
  [key("images/default", "setFraming")]: { kind: "waiver", reason: "the input schema is the framing of the item params.id names: rectangles and ratio keys, no id of another object." },
  [key("media/default", "serve")]: { kind: "test", file: "media-default/module.test.ts", title: "serve: does not return another media item's file for a different name" },

  [key("media/default", "update")]: { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  [key("media/default", "get")]: { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  [key("media/default", "renameFolder")]: { kind: "waiver", reason: "params.path names the folder itself; it is the resource being addressed, not a foreign object's id." },
  [key("media/default", "listFolderItems")]: { kind: "waiver", reason: "params.path names the folder itself; it is the resource being addressed, not a foreign object's id." },

  [key("site/default", "indexPath")]: { kind: "waiver", reason: "the only request-controlled value beside params.id is the written locale, which picks the locale whose slug rule the save must meet, not an object id." },

  [key("persistence/sqlite", "updateOne")]: { kind: "waiver", reason: "a generic per-collection primitive of the persistence contract, not reachable from an HTTP route on its own; the collection/id pairing is enforced by the module that calls it." },

  [key("revisions/default", "list")]: { kind: "waiver", reason: "the only request-controlled values beside params.id are the query limit/offset, not object ids." },
  [key("revisions/default", "read")]: { kind: "test", file: "revisions-default/module.test.ts", title: "read, restore and label ignore a revision id that belongs to another document or collection" },
  [key("revisions/default", "restore")]: { kind: "test", file: "revisions-default/module.test.ts", title: "read, restore and label ignore a revision id that belongs to another document or collection" },
  [key("revisions/default", "label")]: { kind: "test", file: "revisions-default/module.test.ts", title: "read, restore and label ignore a revision id that belongs to another document or collection" },
  [key("revisions/default", "removeTranslation")]: { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  [key("revisions/default", "reassignAuthor")]: {
    kind: "waiver",
    reason: "reads verifiedUser, the canonical { id, name } authn.verifyUser writes after checking the target exists and is active; the dataflow check at boot requires a preceding writer, so every example pipeline runs authn.verifyUser first.",
    upstream: "authn.verifyUser",
  },
};
