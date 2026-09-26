export interface StepSet {
  /** What the set is about, e.g. "authn" or "events.delivery". Identifies the role, not a contract. */
  readonly id: string;
  /** The step prefix the set governs; steps under it that are not members are provider-specific. */
  readonly prefix: string;
  /** Every module in this role registers exactly these steps, with the same context reads and writes. */
  readonly steps: readonly string[];
}
