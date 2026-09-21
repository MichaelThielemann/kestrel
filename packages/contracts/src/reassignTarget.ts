/** A revision author verified against a real, active user; `null` anonymises instead of naming one. */
export type ReassignTarget = { id: string; name: string } | null;

declare global {
  namespace Kestrel {
    interface ContextExtensions {
      /** The verified target for `revisions.reassignAuthor`, written by `authn/multi`'s `verifyUser`. */
      reassignTarget?: ReassignTarget;
    }
  }
}
