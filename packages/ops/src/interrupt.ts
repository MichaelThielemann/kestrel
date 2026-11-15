import type { ObjectStore } from "./store.ts";
import { fixedText, literal } from "./redact.ts";

/** Where a run listens for SIGINT and SIGTERM; `process` unless a test hands in another emitter. */
export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * What a run raises at its next store operation after SIGINT or SIGTERM, so the cleanup of the step it is in runs.
 * `detail`, when given, follows the signal in the message, such as the state the app is left in and the command to run next.
 */
export class Interrupted extends Error {
  override readonly name = "Interrupted";

  constructor(
    readonly signal: "SIGINT" | "SIGTERM",
    detail?: string,
  ) {
    super(detail === undefined ? fixedText`interrupted by ${literal(signal)}` : fixedText`interrupted by ${literal(signal)}; ${detail}`);
  }
}

/**
 * The interrupt state of one run. The first signal aborts {@link Interrupt.signal} and makes the next
 * {@link Interrupt.check} throw {@link Interrupted} once; every later check passes, so restarting the app, releasing the
 * lock and ending the journal still reach the store. A second signal ends the process at once.
 */
export class Interrupt {
  readonly #controller = new AbortController();
  #received: "SIGINT" | "SIGTERM" | null = null;
  #raised = false;

  constructor(private readonly exit: (code: number) => void = (code) => process.exit(code)) {}

  /** Aborted by the first signal; a pending prompt listens to it. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  receive(signal: "SIGINT" | "SIGTERM"): void {
    if (this.#received !== null) {
      this.exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    this.#received = signal;
    this.#controller.abort();
  }

  /** Throws {@link Interrupted} the first time it is called after a signal arrived. */
  check(): void {
    if (this.#received === null || this.#raised) return;
    this.#raised = true;
    throw new Interrupted(this.#received);
  }

  /** Settles like `answer`, or rejects with {@link Interrupted} when a signal arrives first. */
  race<T>(answer: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fail = (error: unknown): void => reject(error instanceof Error ? error : new Error(String(error)));
      const abort = (): void => {
        try {
          this.check();
        } catch (error) {
          fail(error);
        }
      };
      if (this.signal.aborted) abort();
      this.signal.addEventListener("abort", abort, { once: true });
      answer
        .then(resolve, (error: unknown) => {
          abort();
          fail(error);
        })
        .finally(() => this.signal.removeEventListener("abort", abort));
    });
  }

  /** Listens on `source` until the returned function is called. */
  listen(source: SignalSource): () => void {
    const onInt = (): void => this.receive("SIGINT");
    const onTerm = (): void => this.receive("SIGTERM");
    source.on("SIGINT", onInt);
    source.on("SIGTERM", onTerm);
    return () => {
      source.off("SIGINT", onInt);
      source.off("SIGTERM", onTerm);
    };
  }
}

/** `store` with {@link Interrupt.check} before every operation. */
export function interruptible(store: ObjectStore, interrupt: Interrupt): ObjectStore {
  const serverTime = store.serverTime?.bind(store);
  const guarded = <A extends unknown[], R>(op: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      interrupt.check();
      return op(...args);
    };
  return {
    id: store.id,
    locate: (key) => store.locate(key),
    list: guarded((prefix: string) => store.list(prefix)),
    head: guarded((key: string) => store.head(key)),
    get: guarded((key: string) => store.get(key)),
    read: guarded((key: string, options?: { ifMatch?: string }) => store.read(key, options)),
    put: guarded((key: string, data: Uint8Array, options?: { contentType?: string }) => store.put(key, data, options)),
    copy: guarded((sourceKey: string, key: string, options?: Parameters<ObjectStore["copy"]>[2]) => store.copy(sourceKey, key, options)),
    delete: guarded((key: string) => store.delete(key)),
    ...(serverTime === undefined ? {} : { serverTime: guarded(serverTime) }),
  };
}
