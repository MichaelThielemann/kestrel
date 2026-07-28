import type { Principal } from './utils/policy'

declare module 'h3' {
  interface H3EventContext {
    principal?: Principal
    readScope?: 'published' | 'all'
  }
}
