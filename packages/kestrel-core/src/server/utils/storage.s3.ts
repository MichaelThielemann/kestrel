import { createHash } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import type { StorageDriver } from './storage.js'

/**
 * Non-secret S3 settings plus the env-only credentials. Built by `useStorageDriver` from
 * `runtimeConfig.media.s3`; the factory is otherwise free of Nitro/Nuxt globals so it stays
 * unit-testable with an injected `fetch`.
 * @public
 */
export interface S3DriverOptions {
  bucket: string
  /** Signing region (default `us-east-1`). */
  region?: string
  /** Custom endpoint origin for S3-compatible services (R2/MinIO); omit for AWS S3. */
  endpoint?: string
  /** Key prefix prepended to every object key (slashes normalised away). */
  prefix?: string
  /** Public base URL objects are served from; `publicUrl` joins this + the full key. */
  publicBaseUrl: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '')
const stripTrailing = (s: string) => s.replace(/\/+$/, '')
const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/**
 * S3-compatible storage driver over SigV4-signed `fetch` (AWS S3, Cloudflare R2, MinIO). Path-style
 * addressing throughout for maximum compatibility. Credentials are SigV4-signed by `aws4fetch`; the
 * injected `fetchImpl` keeps it fully testable.
 * @public
 */
export function createS3Driver(opts: S3DriverOptions, fetchImpl: typeof fetch = globalThis.fetch): StorageDriver {
  const { bucket, publicBaseUrl } = opts
  const region = opts.region || 'us-east-1'
  const prefix = trimSlashes(opts.prefix || '')
  const origin = opts.endpoint ? stripTrailing(opts.endpoint) : `https://s3.${region}.amazonaws.com`
  const bucketUrl = `${origin}/${bucket}`
  const client = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    sessionToken: opts.sessionToken,
    service: 's3',
    region,
  })

  const fullKey = (key: string) => (prefix ? `${prefix}/${key}` : key)
  const encodePath = (k: string) => k.split('/').map(encodeURIComponent).join('/')
  const objectUrl = (key: string) => `${bucketUrl}/${encodePath(fullKey(key))}`

  async function send(method: string, url: string, init: { body?: Buffer | Uint8Array | string; headers?: Record<string, string> } = {}): Promise<Response> {
    // Buffer/Uint8Array/string are all valid request bodies at runtime; the cast bridges the DOM `BodyInit`
    // type (which omits Node's Buffer, and isn't ambiently available in a plain-package `lib` without DOM)
    // at the single aws4fetch boundary.
    const signed = await client.sign(url, { method, body: init.body as never, headers: init.headers })
    return fetchImpl(signed)
  }

  /** One ListObjectsV2 page: the keys it lists plus the continuation token when more remain. */
  async function listPage(listPrefix: string, token?: string): Promise<{ keys: string[]; next?: string }> {
    const u = new URL(bucketUrl)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', listPrefix)
    if (token) u.searchParams.set('continuation-token', token)
    const res = await send('GET', u.toString())
    if (!res.ok) throw new Error(`S3 list failed (${res.status}) for prefix ${listPrefix}`)
    const xml = await res.text()
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => xmlUnescape(m[1]))
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
    const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)
    return { keys, next: truncated && next ? xmlUnescape(next[1]) : undefined }
  }

  /** Multi-object delete (≤1000 keys, one page). Content-MD5 is required by AWS for this request. */
  async function batchDelete(keys: string[]): Promise<void> {
    if (!keys.length) return
    const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>`
      + keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')
      + `<Quiet>true</Quiet></Delete>`
    const md5 = createHash('md5').update(body).digest('base64')
    const res = await send('POST', `${bucketUrl}?delete`, {
      body,
      headers: { 'content-type': 'application/xml', 'content-md5': md5 },
    })
    if (!res.ok) throw new Error(`S3 batch delete failed (${res.status})`)
    // Quiet mode still returns per-key failures as <Error> elements in the 200 body (retention lock,
    // AccessDenied on some keys). Without parsing them a partial delete passes silently while objects
    // remain — fail loud like every other method here, so removeDir/GC callers never claim a false success.
    const text = await res.text()
    if (text.includes('<Error>')) {
      const failed = [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1])
      throw new Error(`S3 batch delete reported errors for ${failed.length || 'some'} key(s): ${failed.slice(0, 5).join(', ')}`)
    }
  }

  return {
    async list() {
      // Page through every object under the driver prefix, returning keys relative to it so they line
      // up with the keys `put`/`delete` take (the deploy compares them against freshly-uploaded keys).
      const listPrefix = prefix ? `${prefix}/` : ''
      const out: string[] = []
      let token: string | undefined
      do {
        const { keys, next } = await listPage(listPrefix, token)
        for (const k of keys) out.push(listPrefix && k.startsWith(listPrefix) ? k.slice(listPrefix.length) : k)
        token = next
      } while (token)
      return out
    },
    async listPrefix(rel) {
      // Keys under `<driverPrefix>/<rel>/`, returned relative to the driver root (same space as list()).
      const r = trimSlashes(rel)
      if (!r) return this.list!()
      const base = prefix ? `${prefix}/` : ''
      const listPrefix = `${fullKey(r)}/`
      const out: string[] = []
      let token: string | undefined
      do {
        const { keys, next } = await listPage(listPrefix, token)
        for (const k of keys) out.push(base && k.startsWith(base) ? k.slice(base.length) : k)
        token = next
      } while (token)
      return out
    },
    async put(key, bytes, contentType, opts) {
      const headers: Record<string, string> = { 'content-type': contentType }
      if (opts?.cacheControl) headers['cache-control'] = opts.cacheControl
      if (opts?.contentEncoding) headers['content-encoding'] = opts.contentEncoding
      const res = await send('PUT', objectUrl(key), { body: bytes, headers })
      if (!res.ok) throw new Error(`S3 put failed (${res.status}) for ${key}`)
    },
    async copy(srcKey, dstKey) {
      const res = await send('PUT', objectUrl(dstKey), {
        headers: { 'x-amz-copy-source': `/${bucket}/${encodePath(fullKey(srcKey))}` },
      })
      if (!res.ok) throw new Error(`S3 copy failed (${res.status}) ${srcKey} → ${dstKey}`)
      // CopyObject can fail *after* the request was accepted and still answer 200, reporting it as an
      // <Error> body instead of a status. Callers (relocate/duplicate) delete the source once copy
      // resolves, so a silent success here destroys the only bytes — parse the body and fail loud.
      // A real success is `<CopyObjectResult>…`; some S3-compatibles send an empty body.
      const text = await res.text()
      if (text.includes('<Error>')) {
        const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1] ?? 'unknown'
        throw new Error(`S3 copy failed (200 with error body: ${code}) ${srcKey} → ${dstKey}`)
      }
    },
    async delete(key) {
      const res = await send('DELETE', objectUrl(key))
      // DELETE is idempotent on S3; a 404 just means it was already gone (matches the local driver).
      if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed (${res.status}) for ${key}`)
    },
    publicUrl(key) {
      return `${stripTrailing(publicBaseUrl)}/${fullKey(key)}`
    },
    async get(key) {
      const res = await send('GET', objectUrl(key))
      // A read has no idempotent empty result: a 404 (or any non-200) is a genuine error the caller
      // handles (backfill skips, GC keeps-on-doubt) rather than a silently-empty buffer.
      if (!res.ok) throw new Error(`S3 get failed (${res.status}) for ${key}`)
      return Buffer.from(await res.arrayBuffer())
    },
    async exists(key) {
      const res = await send('HEAD', objectUrl(key))
      if (res.status === 200) return true
      if (res.status === 404) return false
      throw new Error(`S3 head failed (${res.status}) for ${key}`)
    },
    async stat(key) {
      const res = await send('HEAD', objectUrl(key))
      if (res.status === 404) return null
      if (res.status !== 200) throw new Error(`S3 head failed (${res.status}) for ${key}`)
      const lastModified = res.headers.get('last-modified')
      const mtimeMs = lastModified ? Date.parse(lastModified) : NaN
      // A gateway/CDN that strips (or garbles) Last-Modified leaves the age unknown; reporting 0 would
      // date the object to 1970 and let every age/grace-window comparison treat it as ancient.
      return { mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null }
    },
    async ensureDir() {
      // No-op: S3 has a flat keyspace with no real directories. Empty folders live only as DB rows.
    },
    async removeDir(folder) {
      const f = stripTrailing(String(folder ?? '')).trim()
      if (!f) return // root guard: never list/delete the whole bucket
      const listPrefix = `${fullKey(f)}/`
      if (listPrefix === '/') return // defense in depth: an empty prefix would match every object
      let token: string | undefined
      do {
        const { keys, next } = await listPage(listPrefix, token)
        await batchDelete(keys)
        token = next
      } while (token)
    },
  }
}
