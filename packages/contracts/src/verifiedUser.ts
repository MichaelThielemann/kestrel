/** A user reference confirmed to exist and be active; `null` when there was none to verify. */
export type VerifiedUser = { id: string; name: string } | null;

declare global {
  namespace Kestrel {
    interface ContextExtensions {
      /** The result of `authn/multi`'s `verifyUser`, confirming a payload-supplied user id exists and is active. */
      verifiedUser?: VerifiedUser;
    }
  }
}
