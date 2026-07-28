// Read a request body stream into a Buffer, but ABORT once it exceeds `maxBytes`. The public proofing route's
// cheap `content-length` pre-check can't catch a chunked/streamed request (no declared length, or a lying one),
// and h3's `readBody`/`readRawBody` buffer the whole body with no cap — so an unbounded chunked flood could
// balloon memory before validation runs. This caps the ACTUAL bytes read and stops pulling from the stream the
// moment the cap is passed. Pure over an async iterable of chunks → node-testable; the handler passes
// `event.node.req` (a Node Readable is async-iterable). Returns the buffered body, or null if the cap was
// exceeded (the caller maps null → 413).
export async function readCappedBody(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) return null // over the cap → stop reading; the caller throws 413
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
