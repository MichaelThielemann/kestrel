import { Effect, Schema } from 'effect'
import { expectTypeOf } from 'vitest'
import type { EscapedHtml, PublishedSnapshot, ResolvedSlug, SanitizedRichtext } from '../src/brands.js'
import { SanitizedRichtext as SanitizedRichtextSchema } from '../src/brands.js'
import type {
  Conflict,
  Forbidden,
  KestrelError,
  Locked,
  NotFound,
  Quarantined,
  Unauthorized,
  ValidationFailed,
} from '../src/errors.js'
import type {
  AdapterContract,
  DeliveryPort,
  IdentityProviderAdapter,
  IdentityVerification,
  MediaStorageAdapter,
  StorageAdapter,
} from '../src/extension-points.js'
import {
  IdentityProviderAdapterSchemas,
  MediaStorageAdapterSchemas,
  StorageAdapterSchemas,
} from '../src/extension-points.js'

// @ts-expect-error a plain string is not a SanitizedRichtext
const _sanitized: SanitizedRichtext = 'plain'

// @ts-expect-error a plain string is not an EscapedHtml
const _escaped: EscapedHtml = 'plain'

// @ts-expect-error a plain string is not a ResolvedSlug
const _slug: ResolvedSlug = 'plain'

declare const sanitized: SanitizedRichtext
// @ts-expect-error distinct brands: SanitizedRichtext is not assignable to EscapedHtml
const _crossBrand: EscapedHtml = sanitized

// Decoding through the schema is the sanctioned way to obtain a branded value.
const decoded: SanitizedRichtext = Schema.decodeUnknownSync(SanitizedRichtextSchema)('<p>ok</p>')
expectTypeOf(decoded).toEqualTypeOf<SanitizedRichtext>()

declare const failing: Effect.Effect<number, KestrelError>

// Handling all seven tags compiles and narrows the error channel to `never`.
const _handled = Effect.catchTags(failing, {
  NotFound: (_e: NotFound) => Effect.succeed(0),
  Forbidden: (_e: Forbidden) => Effect.succeed(0),
  Unauthorized: (_e: Unauthorized) => Effect.succeed(0),
  Conflict: (_e: Conflict) => Effect.succeed(0),
  ValidationFailed: (_e: ValidationFailed) => Effect.succeed(0),
  Locked: (_e: Locked) => Effect.succeed(0),
  Quarantined: (_e: Quarantined) => Effect.succeed(0),
})
expectTypeOf<Effect.Effect.Error<typeof _handled>>().toEqualTypeOf<never>()

// Every StorageAdapter/MediaStorageAdapter/IdentityProviderAdapter method returns a Promise, except
// `publicUrl`, which is deliberately synchronous (pure string construction — see AdapterContract's doc).
expectTypeOf<ReturnType<StorageAdapter['put']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<StorageAdapter['delete']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<StorageAdapter['exists']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<StorageAdapter['list']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<StorageAdapter['publicUrl']>>().toEqualTypeOf<string>()
expectTypeOf<ReturnType<MediaStorageAdapter['get']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<MediaStorageAdapter['copy']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<MediaStorageAdapter['stat']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<MediaStorageAdapter['ensureDir']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<MediaStorageAdapter['removeDir']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<MediaStorageAdapter['listPrefix']>>().toMatchTypeOf<Promise<unknown>>()
expectTypeOf<ReturnType<IdentityProviderAdapter['verifyCredentials']>>().toMatchTypeOf<Promise<unknown>>()

// Every method name in each adapter appears in its paired schema record — AdapterContract makes a
// missing pair a compile error, so simply assigning the schema constants to the contract type proves it.
const _storageContract: AdapterContract<StorageAdapter> = StorageAdapterSchemas
const _mediaContract: AdapterContract<MediaStorageAdapter> = MediaStorageAdapterSchemas
const _identityContract: AdapterContract<IdentityProviderAdapter> = IdentityProviderAdapterSchemas
void _storageContract
void _mediaContract
void _identityContract

// @ts-expect-error a schema record missing a method is not a valid AdapterContract
const _incompleteContract: AdapterContract<StorageAdapter> = {
  put: Schema.Void,
  delete: Schema.Void,
  exists: Schema.Boolean,
  list: Schema.Array(Schema.String),
}

declare const deliveryPort: DeliveryPort
declare const snapshot: PublishedSnapshot
const _delivered: Promise<void> = deliveryPort.publishSnapshot(snapshot)
void _delivered
// @ts-expect-error DeliveryPort.publishSnapshot only accepts a PublishedSnapshot, not a plain object
deliveryPort.publishSnapshot({ foo: 'bar' })

// IdentityVerification is a discriminated union: `subject` is only readable once `ok` narrows to `true`.
declare const verification: IdentityVerification
if (verification.ok) {
  expectTypeOf(verification.subject).toEqualTypeOf<string>()
}
// @ts-expect-error `subject` does not exist on the `{ ok: false }` branch
const _noSubject = verification.ok ? undefined : verification.subject
void _noSubject
// @ts-expect-error `ok: false` cannot carry a `subject`
const _wrongShape: IdentityVerification = { ok: false, subject: 'admin' }
