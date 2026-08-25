declare module '#kestrel/collections' {
  const collections: unknown[]
  export default collections
}
declare module '#kestrel/blocks' {
  const blocks: unknown[]
  export default blocks
}
declare module '#kestrel/schema-tables' {
  const tables: unknown[]
  export default tables
}
declare module '#kestrel/module-manifests' {
  import type { OwnershipManifest } from '@kestrel/contracts'
  const manifests: OwnershipManifest[]
  export default manifests
}
declare module '#build/kestrel-layouts.mjs' {
  export const kestrelLayouts: string[]
}
