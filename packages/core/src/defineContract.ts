export interface Contract<T> {
  readonly name: string;
  readonly methods: readonly string[];
  readonly instance?: T;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type MethodKeys<T> = { [K in keyof T]-?: T[K] extends Function ? K : never }[keyof T] & string;

// [MethodKeys<T>] extends [M[number]] forces M to cover every method key of T; missing keys resolve to `never`.
type CompleteMethodList<T, M extends readonly MethodKeys<T>[]> = [MethodKeys<T>] extends [M[number]] ? M : never;

// Curried so M is inferred fresh at the second call, independent of the CompleteMethodList check on its own parameter.
export function defineContract<T>(): <const M extends readonly MethodKeys<T>[]>(name: string, methods: CompleteMethodList<T, M>) => Contract<T> {
  return (name, methods) => {
    if (!/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(name)) throw new Error(`defineContract: name "${name}" must look like "<capability>@<major>"`);
    if (methods.length === 0) throw new Error(`defineContract: contract "${name}" declares no methods`);
    return { name, methods };
  };
}

export function missingMethods<T>(contract: Contract<T>, instance: unknown): string[] {
  if (instance === null || (typeof instance !== "object" && typeof instance !== "function")) return [...contract.methods];
  const obj = instance as Record<string, unknown>;
  return contract.methods.filter((m) => typeof obj[m] !== "function");
}
