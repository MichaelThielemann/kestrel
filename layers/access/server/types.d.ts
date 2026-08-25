import type { Principal } from '@kestrel/access'

declare module 'h3' {
  interface H3EventContext {
    principal?: Principal
  }
}
