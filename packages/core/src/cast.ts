export type Boundary = "json" | "ast" | "dom" | "host";

/** The only sanctioned double cast. `boundary` says which untyped source the value came from. */
export function boundaryCast<T>(value: unknown, boundary: Boundary): T {
  void boundary;
  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-unnecessary-type-assertion
  return value as unknown as T;
}
