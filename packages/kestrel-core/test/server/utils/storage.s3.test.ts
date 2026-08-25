import { describe, it, expect } from 'vitest'
import { createS3Driver } from '../../../src/server/utils/storage.s3.js'

type Call = { method: string; url: string; headers: Record<string, string>; body?: Buffer }

/** A fake `fetch` that records every (already-signed) request and replies via `respond`. */
function recorder(respond: (call: Call) => Response = () => new Response('', { status: 200 })) {
  const calls: Call[] = []
  const fetchImpl = (async (req: Request): Promise<Response> => {
    const buf = Buffer.from(await req.arrayBuffer())
    const call: Call = {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(req.headers.entries()),
      body: buf.length ? buf : undefined,
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const base = {
  bucket: 'my-bucket',
  region: 'eu-central-1',
  publicBaseUrl: 'https://cdn.example.com',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

const AWS_HOST = 'https://s3.eu-central-1.amazonaws.com'

describe('createS3Driver — request wire format + SigV4', () => {
  it('put: PUT to path-style object URL with body, content-type, and a SigV4 authorization', async () => {
    const { calls, fetchImpl } = recorder()
    const d = createS3Driver(base, fetchImpl)
    await d.put('seite-a/hero.webp', Buffer.from('IMG'), 'image/webp')

    expect(calls).toHaveLength(1)
    const c = calls[0]
    expect(c.method).toBe('PUT')
    expect(c.url).toBe(`${AWS_HOST}/my-bucket/seite-a/hero.webp`)
    expect(c.body?.toString()).toBe('IMG')
    expect(c.headers['content-type']).toBe('image/webp')
    expect(c.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request,/)
    expect(c.headers['authorization']).toContain('Signature=')
    expect(c.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    expect(c.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it('put: forwards an optional Cache-Control header, omits it when not given', async () => {
    const withCc = recorder()
    await createS3Driver(base, withCc.fetchImpl).put('_nuxt/app.js', Buffer.from('x'), 'text/javascript', { cacheControl: 'public, max-age=31536000, immutable' })
    expect(withCc.calls[0].headers['cache-control']).toBe('public, max-age=31536000, immutable')

    const without = recorder()
    await createS3Driver(base, without.fetchImpl).put('x.bin', Buffer.from('x'), 'application/octet-stream')
    expect(without.calls[0].headers['cache-control']).toBeUndefined()
  })

  it('put: forwards an optional Content-Encoding header for pre-compressed objects, omits it otherwise', async () => {
    const withCe = recorder()
    await createS3Driver(base, withCe.fetchImpl).put('_nuxt/app.js.br', Buffer.from('x'), 'text/javascript', { contentEncoding: 'br' })
    expect(withCe.calls[0].headers['content-encoding']).toBe('br')

    const without = recorder()
    await createS3Driver(base, without.fetchImpl).put('_nuxt/app.js', Buffer.from('x'), 'text/javascript')
    expect(without.calls[0].headers['content-encoding']).toBeUndefined()
  })

  it('put: throws on a non-2xx response', async () => {
    const { fetchImpl } = recorder(() => new Response('Access Denied', { status: 403 }))
    const d = createS3Driver(base, fetchImpl)
    await expect(d.put('x.bin', Buffer.from('x'), 'application/octet-stream')).rejects.toThrow(/403/)
  })

  it('key prefix is prepended to every object key and to publicUrl (slashes normalised)', async () => {
    const { calls, fetchImpl } = recorder()
    const d = createS3Driver({ ...base, prefix: '/media/' }, fetchImpl)
    await d.put('a/b.webp', Buffer.from('x'), 'image/webp')
    expect(calls[0].url).toBe(`${AWS_HOST}/my-bucket/media/a/b.webp`)
    expect(d.publicUrl('a/b.webp')).toBe('https://cdn.example.com/media/a/b.webp')
  })

  it('publicUrl is a pure join of publicBaseUrl + key (no I/O, trailing slash trimmed)', () => {
    const { calls, fetchImpl } = recorder()
    const d = createS3Driver({ ...base, publicBaseUrl: 'https://cdn.example.com/' }, fetchImpl)
    expect(d.publicUrl('seite-a/hero.webp')).toBe('https://cdn.example.com/seite-a/hero.webp')
    expect(calls).toHaveLength(0)
  })

  it('custom endpoint (R2/MinIO) replaces the AWS host, still path-style', async () => {
    const { calls, fetchImpl } = recorder()
    const d = createS3Driver({ ...base, endpoint: 'https://minio.local:9000' }, fetchImpl)
    await d.put('k.txt', Buffer.from('x'), 'text/plain')
    expect(calls[0].url).toBe('https://minio.local:9000/my-bucket/k.txt')
    expect(calls[0].headers['host']).toBeUndefined() // host is implicit; never a stored header
  })

  it('copy: PUT with a URL-encoded x-amz-copy-source pointing at /bucket/srcKey', async () => {
    const { calls, fetchImpl } = recorder()
    const d = createS3Driver({ ...base, prefix: 'media' }, fetchImpl)
    await d.copy('a/src.webp', 'b/c/dst.webp')
    const c = calls[0]
    expect(c.method).toBe('PUT')
    expect(c.url).toBe(`${AWS_HOST}/my-bucket/media/b/c/dst.webp`)
    expect(c.headers['x-amz-copy-source']).toBe('/my-bucket/media/a/src.webp')
    expect(c.headers['authorization']).toContain('AWS4-HMAC-SHA256')
  })

  it('copy: throws when the (200) CopyObject reply carries an <Error> body (mid-copy failure)', async () => {
    const errBody = '<?xml version="1.0"?><Error><Code>InternalError</Code><Message>We encountered an internal error</Message></Error>'
    const { fetchImpl } = recorder(() => new Response(errBody, { status: 200 }))
    await expect(createS3Driver(base, fetchImpl).copy('a/src.webp', 'b/dst.webp')).rejects.toThrow(/InternalError/)
  })

  it('copy: a CopyObjectResult body and an empty body both count as success', async () => {
    const okXml = recorder(() => new Response('<?xml version="1.0"?><CopyObjectResult><ETag>"abc"</ETag></CopyObjectResult>', { status: 200 }))
    await expect(createS3Driver(base, okXml.fetchImpl).copy('a/src.webp', 'b/dst.webp')).resolves.toBeUndefined()

    const empty = recorder(() => new Response('', { status: 200 }))
    await expect(createS3Driver(base, empty.fetchImpl).copy('a/src.webp', 'b/dst.webp')).resolves.toBeUndefined()
  })

  it('delete: DELETE the object; a 404 is swallowed (idempotent, parity with local)', async () => {
    const ok = recorder(() => new Response(null, { status: 204 }))
    const d1 = createS3Driver(base, ok.fetchImpl)
    await d1.delete('a/x.webp')
    expect(ok.calls[0].method).toBe('DELETE')
    expect(ok.calls[0].url).toBe(`${AWS_HOST}/my-bucket/a/x.webp`)

    const gone = recorder(() => new Response('', { status: 404 }))
    await expect(createS3Driver(base, gone.fetchImpl).delete('missing')).resolves.toBeUndefined()
  })

  it('exists: HEAD → 200 true, 404 false, other status throws', async () => {
    const yes = recorder(() => new Response('', { status: 200 }))
    expect(await createS3Driver(base, yes.fetchImpl).exists!('a.webp')).toBe(true)
    expect(yes.calls[0].method).toBe('HEAD')

    const no = recorder(() => new Response('', { status: 404 }))
    expect(await createS3Driver(base, no.fetchImpl).exists!('a.webp')).toBe(false)

    const boom = recorder(() => new Response('', { status: 500 }))
    await expect(createS3Driver(base, boom.fetchImpl).exists!('a.webp')).rejects.toThrow(/500/)
  })

  it('stat: parses Last-Modified; 404 → null; other status throws', async () => {
    const at = 'Wed, 09 Jul 2025 10:11:12 GMT'
    const ok = recorder(() => new Response('', { status: 200, headers: { 'last-modified': at } }))
    expect(await createS3Driver(base, ok.fetchImpl).stat!('a.webp')).toEqual({ mtimeMs: Date.parse(at) })
    expect(ok.calls[0].method).toBe('HEAD')

    const gone = recorder(() => new Response('', { status: 404 }))
    expect(await createS3Driver(base, gone.fetchImpl).stat!('a.webp')).toBe(null)

    const boom = recorder(() => new Response('', { status: 500 }))
    await expect(createS3Driver(base, boom.fetchImpl).stat!('a.webp')).rejects.toThrow(/500/)
  })

  it('stat: an absent or unparseable Last-Modified is an UNKNOWN age (null), not epoch 0', async () => {
    // A gateway/CDN that strips the header would otherwise make every object look ~56 years old, inverting
    // the age comparisons that spare recently-written objects from a prune.
    const stripped = recorder(() => new Response('', { status: 200 }))
    expect(await createS3Driver(base, stripped.fetchImpl).stat!('a.webp')).toEqual({ mtimeMs: null })

    const garbled = recorder(() => new Response('', { status: 200, headers: { 'last-modified': 'not-a-date' } }))
    expect(await createS3Driver(base, garbled.fetchImpl).stat!('a.webp')).toEqual({ mtimeMs: null })
  })

  it('ensureDir is a no-op (S3 has no directories)', async () => {
    const { calls, fetchImpl } = recorder()
    await createS3Driver(base, fetchImpl).ensureDir!('a/b/c')
    expect(calls).toHaveLength(0)
  })

  describe('list', () => {
    const listXml = (keys: string[], opts: { truncated?: boolean; next?: string } = {}) =>
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
      `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>` +
      (opts.next ? `<NextContinuationToken>${opts.next}</NextContinuationToken>` : '') +
      keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('') +
      `</ListBucketResult>`

    it('with no prefix, returns the full keys and paginates', async () => {
      let page = 0
      const { calls, fetchImpl } = recorder(() => {
        page++
        return page === 1
          ? new Response(listXml(['index.html'], { truncated: true, next: 'T2' }), { status: 200 })
          : new Response(listXml(['a/b.js']), { status: 200 })
      })
      const keys = await createS3Driver(base, fetchImpl).list!()
      expect(keys).toEqual(['index.html', 'a/b.js'])
      const gets = calls.filter((c) => c.method === 'GET')
      expect(gets).toHaveLength(2)
      expect(new URL(gets[1].url).searchParams.get('continuation-token')).toBe('T2')
    })

    it('strips the global key prefix so keys match the put/delete space', async () => {
      const { calls, fetchImpl } = recorder(() =>
        new Response(listXml(['site/index.html', 'site/_nuxt/app.js']), { status: 200 }))
      const keys = await createS3Driver({ ...base, prefix: 'site' }, fetchImpl).list!()
      expect(keys).toEqual(['index.html', '_nuxt/app.js'])
      expect(new URL(calls[0].url).searchParams.get('prefix')).toBe('site/')
    })
  })

  describe('removeDir', () => {
    const listXml = (keys: string[], opts: { truncated?: boolean; next?: string } = {}) =>
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
      `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>` +
      (opts.next ? `<NextContinuationToken>${opts.next}</NextContinuationToken>` : '') +
      keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('') +
      `</ListBucketResult>`

    it('lists with list-type=2 and a TRAILING-SLASH prefix, then batch-deletes the keys', async () => {
      const { calls, fetchImpl } = recorder((c) =>
        c.method === 'GET' ? new Response(listXml(['a/1.webp', 'a/2.webp']), { status: 200 })
          : new Response('<DeleteResult/>', { status: 200 }))
      const d = createS3Driver(base, fetchImpl)
      await d.removeDir!('a')

      const get = calls.find((c) => c.method === 'GET')!
      const post = calls.find((c) => c.method === 'POST')!
      const gu = new URL(get.url)
      expect(gu.searchParams.get('list-type')).toBe('2')
      expect(gu.searchParams.get('prefix')).toBe('a/') // trailing slash: 'a' must not match 'ab/...'
      expect(new URL(post.url).searchParams.has('delete')).toBe(true)
      const body = post.body!.toString()
      expect(body).toContain('<Key>a/1.webp</Key>')
      expect(body).toContain('<Key>a/2.webp</Key>')
      expect(post.headers['content-md5']).toBeTruthy()
      expect(post.headers['authorization']).toContain('AWS4-HMAC-SHA256')
    })

    it('throws when the (200) DeleteResult reports per-key <Error> entries (Quiet mode partial failure)', async () => {
      const errBody = '<?xml version="1.0"?><DeleteResult><Error><Key>a/2.webp</Key><Code>AccessDenied</Code></Error></DeleteResult>'
      const { fetchImpl } = recorder((c) =>
        c.method === 'GET' ? new Response(listXml(['a/1.webp', 'a/2.webp']), { status: 200 })
          : new Response(errBody, { status: 200 }))
      await expect(createS3Driver(base, fetchImpl).removeDir!('a')).rejects.toThrow(/a\/2\.webp|batch delete/)
    })

    it('honours the global key prefix in the list prefix', async () => {
      const { calls, fetchImpl } = recorder((c) =>
        c.method === 'GET' ? new Response(listXml([]), { status: 200 }) : new Response('', { status: 200 }))
      await createS3Driver({ ...base, prefix: 'media' }, fetchImpl).removeDir!('a/b')
      expect(new URL(calls[0].url).searchParams.get('prefix')).toBe('media/a/b/')
    })

    it('paginates via continuation-token until not truncated', async () => {
      let page = 0
      const { calls, fetchImpl } = recorder((c) => {
        if (c.method === 'POST') return new Response('', { status: 200 })
        page++
        return page === 1
          ? new Response(listXml(['a/1'], { truncated: true, next: 'TOK2' }), { status: 200 })
          : new Response(listXml(['a/2']), { status: 200 })
      })
      await createS3Driver(base, fetchImpl).removeDir!('a')
      const gets = calls.filter((c) => c.method === 'GET')
      const posts = calls.filter((c) => c.method === 'POST')
      expect(gets).toHaveLength(2)
      expect(new URL(gets[1].url).searchParams.get('continuation-token')).toBe('TOK2')
      expect(posts).toHaveLength(2)
    })

    it('an empty listing issues no delete', async () => {
      const { calls, fetchImpl } = recorder(() => new Response(listXml([]), { status: 200 }))
      await createS3Driver(base, fetchImpl).removeDir!('a')
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1)
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    })

    it('removeDir("") is a no-op — never lists/deletes the bucket root', async () => {
      const { calls, fetchImpl } = recorder()
      await createS3Driver(base, fetchImpl).removeDir!('')
      await createS3Driver({ ...base, prefix: 'media' }, fetchImpl).removeDir!('')
      expect(calls).toHaveLength(0)
    })
  })
})
