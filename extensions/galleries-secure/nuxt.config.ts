// Kestrel extension layer — the foundation for zero-knowledge encrypted galleries. OPT-IN: a consumer
// composes it AFTER the core, so it builds on Kestrel's seams (defineFieldType / useStorageDriver):
//
//   extends: ['@thielemann/kestrel', '@thielemann/kestrel-galleries-secure']
//
// It is intentionally NOT a meta-layer over Kestrel (no `extends: ['@thielemann/kestrel']` here) — the consumer owns
// the layer order, and `kestrel` is a peerDependency the consumer provides. Feature code lives in server/
// and app/, auto-discovered by Nuxt when this layer is extended.
export default defineNuxtConfig({})
