/** A device the account a request names has signed in from before, shown by a valid device cookie bound to that account. */
export interface KnownDevice {
  /** A stable identifier of the device cookie that reveals nothing of the cookie itself, fit for a log. */
  id: string;
}

declare global {
  namespace Kestrel {
    interface ContextExtensions {
      /** Set by a rate-limit check that recognised a device cookie bound to the account the request names; absent for every other request. */
      knownDevice?: KnownDevice;
    }
  }
}
