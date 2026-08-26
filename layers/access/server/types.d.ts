import type { Principal } from '@michaelthielemann/kestrel-access'

declare module 'h3' {
  interface H3EventContext {
    principal?: Principal
  }
}
