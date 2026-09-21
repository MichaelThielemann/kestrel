/**
 * Disposition of every candidate `objectBindingCandidates()` finds: either a test that proves a
 * foreign id (one belonging to a different parent object) is rejected, or a written waiver
 * explaining why the candidate carries no such risk. See `objectBinding.scan.test.ts`.
 */
export type ObjectBindingDisposition =
  | { kind: "test"; file: string; title: string }
  | { kind: "waiver"; reason: string };

/** Keyed by `<module prefix>.<step>`, exactly as `objectBindingCandidates()` names it. */
export const OBJECT_BINDING_REGISTRY: Record<string, ObjectBindingDisposition> = {
  "audit.anonymize": { kind: "waiver", reason: "params.id names the only user this step acts on; there is no second object to bind to." },
  "authn.updateUser": { kind: "waiver", reason: "params.id names the only user this step acts on; there is no second object to bind to." },
  "authn.setPassword": { kind: "waiver", reason: "params.id names the only user this step acts on; there is no second object to bind to." },
  "authn.deleteUser": { kind: "test", file: "authn-multi/module.test.ts", title: "deleteUser keeps the user when the reassign target is unknown, inactive, themselves or not an id" },

  "content.update": { kind: "waiver", reason: "the input schema is the document's own fields; a reference to another document is validated by references-default, not by content itself." },
  "content.removeTranslation": { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },

  "images.serve": { kind: "test", file: "images-default/impl.test.ts", title: "does not serve another media item's variant of the same size name" },

  "media.update": { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  "media.get": { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  "media.renameFolder": { kind: "waiver", reason: "params.path names the folder itself; it is the resource being addressed, not a foreign object's id." },
  "media.listFolderItems": { kind: "waiver", reason: "params.path names the folder itself; it is the resource being addressed, not a foreign object's id." },
  "media.folderItems": { kind: "waiver", reason: "deprecated alias of media.listFolderItems; params.path names the folder itself, not a foreign object's id." },

  "persistence.updateOne": { kind: "waiver", reason: "a generic per-collection primitive of the persistence contract, not reachable from an HTTP route on its own; the collection/id pairing is enforced by the module that calls it." },

  "revisions.list": { kind: "waiver", reason: "the only request-controlled values beside params.id are the query limit/offset, not object ids." },
  "revisions.read": { kind: "test", file: "revisions-default/module.test.ts", title: "read, restore and label ignore a revision id that belongs to another document or collection" },
  "revisions.restore": { kind: "test", file: "revisions-default/module.test.ts", title: "read, restore and label ignore a revision id that belongs to another document or collection" },
  "revisions.label": { kind: "test", file: "revisions-default/module.test.ts", title: "read, restore and label ignore a revision id that belongs to another document or collection" },
  "revisions.removeTranslation": { kind: "waiver", reason: "the only request-controlled value beside params.id is the query locale, not an object id." },
  "revisions.reassignAuthor": {
    kind: "waiver",
    reason: "the id/reassignTo pair is validated upstream by authn.deleteUser before the user.deleted event fires; the retry route additionally requires authn.requireUser and authz.require:users.manage.",
  },
};
