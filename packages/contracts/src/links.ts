export const INTERNAL_REF = /kestrel:([a-z][a-z0-9_]*):([A-Za-z0-9-]+)/g;

export interface InternalRef {
  type: string;
  id: string;
}

/** Where an internal reference points after a site resolved it: a public path, or nothing servable. */
export type LinkTarget = { path: string; locale: string } | { broken: true };
