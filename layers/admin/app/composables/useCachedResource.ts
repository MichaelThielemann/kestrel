// Generic cached-resource loader: a `useState`-backed list that fetches once and is shared by every
// caller. Backs `useBlocks` / `useCollections` (structurally identical loaders).
//
// SSR isolation: the in-flight (dedup) promise is keyed first by the per-request Nuxt app (a WeakMap,
// so it can't leak across SSR requests) AND then by `stateKey` — otherwise two different resources
// loading concurrently in ONE request would share a single promise and cross-contaminate (one
// resolves with the other's data).
const inflight = new WeakMap<object, Map<string, Promise<unknown>>>()

export function useCachedResource<T>(stateKey: string, url: string) {
  const state = useState<T[] | null>(stateKey, () => null)
  const nuxtApp = useNuxtApp()

  async function load(): Promise<T[]> {
    if (state.value) return state.value
    let perApp = inflight.get(nuxtApp)
    if (!perApp) {
      perApp = new Map()
      inflight.set(nuxtApp, perApp)
    }
    let pending = perApp.get(stateKey) as Promise<T[]> | undefined
    if (!pending) {
      pending = $fetch<{ data: T[] }>(url)
        .then(({ data }) => {
          state.value = data
          return data
        })
        .finally(() => perApp!.delete(stateKey))
      perApp.set(stateKey, pending)
    }
    return pending
  }

  return { state, load }
}
