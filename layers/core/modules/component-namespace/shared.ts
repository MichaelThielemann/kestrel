import { fileURLToPath } from 'node:url'

export const KESTREL_COMPONENT_PREFIX = 'Kestrel'

/**
 * Above every layer-derived priority (Nuxt assigns `layerCount - i`, so the consumer's app dir — index 0
 * — otherwise always wins). A consumer file that lands on a `Kestrel*` name anywhere but the override
 * directory therefore loses instead of silently replacing the admin component.
 */
export const KESTREL_LAYER_PRIORITY = 100

/** The one supported override seam, above the layers. */
export const KESTREL_OVERRIDE_PRIORITY = 200

/**
 * The components directory of a Kestrel layer, namespaced. Nuxt drops a prefix the filename already
 * carries, so `KestrelImg.vue` stays `KestrelImg` while `ui/Button.vue` becomes `KestrelUiButton`.
 * Pass the layer's own `import.meta.url`.
 */
export const kestrelComponents = (layerUrl: string) => ({
  path: fileURLToPath(new URL('./app/components', layerUrl)),
  prefix: KESTREL_COMPONENT_PREFIX,
  priority: KESTREL_LAYER_PRIORITY,
})
