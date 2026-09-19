export interface Contract<T> {
  readonly name: string;
  readonly methods: readonly string[];
  readonly instance?: T;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type MethodKeys<T> = { [K in keyof T]-?: T[K] extends Function ? K : never }[keyof T] & string;

type CompleteMethodList<T, M extends readonly MethodKeys<T>[]> = [MethodKeys<T>] extends [M[number]] ? M : never;

export function defineContract<T>(): <const M extends readonly MethodKeys<T>[]>(name: string, methods: CompleteMethodList<T, M>) => Contract<T> {
  return (name, methods) => {
    if (!/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(name)) throw new Error(`defineContract: name "${name}" must look like "<capability>@<major>"`);
    if (methods.length === 0) throw new Error(`defineContract: contract "${name}" declares no methods`);
    return { name, methods };
  };
}

export function missingMethods<T>(contract: Contract<T>, instance: unknown): string[] {
  if (instance === null || (typeof instance !== "object" && typeof instance !== "function")) return [...contract.methods];
  return contract.methods.filter((m) => typeof Reflect.get(instance, m) !== "function");
}
