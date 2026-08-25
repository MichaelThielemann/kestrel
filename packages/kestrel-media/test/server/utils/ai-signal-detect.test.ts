import { describe, it, expect, beforeAll } from 'vitest'
import { deflateSync } from 'node:zlib'
import sharp from 'sharp'
import { detectAiSignal } from '../../../src/server/utils/ai-signal-detect.js'

// --- fixture builders (synthetic, no binary files in the repo) -----------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function withPngChunk(png: Buffer, chunk: Buffer): Buffer {
  const iend = png.lastIndexOf(Buffer.from('IEND', 'latin1')) - 4
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)])
}
/** Splice a JPEG APP segment in right after SOI. */
function withJpegSegment(jpg: Buffer, marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2)
  const seg = Buffer.concat([Buffer.from([0xFF, marker]), len, payload])
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)])
}
const XMP_NS = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1')
const xmpPacket = (sourceType: string) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">`
  + `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""`
  + ` xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"`
  + ` Iptc4xmpExt:DigitalSourceType="${sourceType}"/></rdf:RDF></x:xmpmeta><?xpacket end="r"?>`
const TRAINED = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'

let basePng: Buffer
let baseJpg: Buffer
let baseWebp: Buffer

beforeAll(async () => {
  const create = { width: 8, height: 8, channels: 3 as const, background: '#123456' }
  basePng = await sharp({ create }).png().toBuffer()
  baseJpg = await sharp({ create }).jpeg().toBuffer()
  baseWebp = await sharp({ create }).webp().toBuffer()
})

describe('detectAiSignal — evidence only, never a classification', () => {
  it('reads the IPTC/XMP Digital Source Type a generator self-declared', async () => {
    const jpg = withJpegSegment(baseJpg, 0xE1, Buffer.concat([XMP_NS, Buffer.from(xmpPacket(TRAINED))]))
    const found = await detectAiSignal(jpg, 'image/jpeg')
    expect(found!.evidence).toHaveLength(1)
    expect(found!.evidence[0]).toContain('Digital Source Type')
    expect(found!.evidence[0]).toContain('trainedAlgorithmicMedia')
  })

  it('reads the XMP packet out of a WebP too (exifr cannot open that container)', async () => {
    // WebP carries XMP in a RIFF "XMP " chunk; the packet itself is the same XML.
    const packet = Buffer.from(xmpPacket(TRAINED))
    const pad = packet.length % 2
    const chunk = Buffer.concat([Buffer.from('XMP ', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(packet.length); return b })(), packet, Buffer.alloc(pad)])
    const withXmp = Buffer.concat([baseWebp, chunk])
    withXmp.writeUInt32LE(withXmp.length - 8, 4) // fix the RIFF size
    const found = await detectAiSignal(withXmp, 'image/webp')
    expect(found!.evidence.join(' ')).toContain('trainedAlgorithmicMedia')
  })

  it('reads an EXIF Software tag naming a known generator', async () => {
    const jpg = await sharp(baseJpg).withExif({ IFD0: { Software: 'Midjourney' } }).jpeg().toBuffer()
    const found = await detectAiSignal(jpg, 'image/jpeg')
    expect(found!.evidence).toEqual(['EXIF Software: Midjourney'])
  })

  it('ignores an EXIF Software tag from ordinary editing software', async () => {
    const jpg = await sharp(baseJpg).withExif({ IFD0: { Software: 'Adobe Photoshop 26.0 (Macintosh)' } }).jpeg().toBuffer()
    expect(await detectAiSignal(jpg, 'image/jpeg')).toBeNull()
  })

  it('reports a C2PA manifest as PRESENT ONLY and says so — never as a verified claim', async () => {
    const png = withPngChunk(basePng, pngChunk('caBX', Buffer.from('c2pa store bytes')))
    const found = await detectAiSignal(png, 'image/png')
    expect(found!.evidence).toHaveLength(1)
    expect(found!.evidence[0]).toContain('C2PA')
    expect(found!.evidence[0]).toContain('unverified')
    // no signature is checked here, so nothing may read as trusted/valid/verified-by-us
    expect(found!.evidence[0]).not.toMatch(/\bvalid\b|\btrusted\b|\bverified\b(?! )/i)
  })

  it('detects a C2PA manifest in a JPEG APP11 JUMBF segment as well', async () => {
    const jpg = withJpegSegment(baseJpg, 0xEB, Buffer.concat([Buffer.from('JP'), Buffer.from([0, 1, 0, 1]), Buffer.from('...jumbc2pa...')]))
    expect((await detectAiSignal(jpg, 'image/jpeg'))!.evidence[0]).toContain('C2PA')
  })

  it('names the Stable-Diffusion-style PNG text chunk it matched (uncompressed tEXt)', async () => {
    const png = withPngChunk(basePng, pngChunk('tEXt', Buffer.from('parameters\0masterpiece, Steps: 20', 'latin1')))
    const found = await detectAiSignal(png, 'image/png')
    expect(found!.evidence).toEqual(['PNG text chunk "parameters" present (Stable-Diffusion-style generation parameters)'])
  })

  it('also matches a COMPRESSED zTXt chunk — exifr only decodes tEXt', async () => {
    const data = Buffer.concat([Buffer.from('workflow\0\0', 'latin1'), deflateSync(Buffer.from('a ComfyUI graph'))])
    const png = withPngChunk(basePng, pngChunk('zTXt', data))
    expect((await detectAiSignal(png, 'image/png'))!.evidence[0]).toContain('"workflow"')
  })

  it('collects EVERY signal in one file, not just the first', async () => {
    let png = withPngChunk(basePng, pngChunk('tEXt', Buffer.from('prompt\0a cat', 'latin1')))
    png = withPngChunk(png, pngChunk('caBX', Buffer.from('c2pa')))
    png = withPngChunk(png, pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(xmpPacket(TRAINED))])))
    const evidence = (await detectAiSignal(png, 'image/png'))!.evidence
    expect(evidence).toHaveLength(3)
    expect(evidence.join(' | ')).toContain('Digital Source Type')
    expect(evidence.join(' | ')).toContain('C2PA')
    expect(evidence.join(' | ')).toContain('"prompt"')
  })

  it('finds nothing in an ordinary camera shot (no false positive from Make/Model)', async () => {
    const jpg = await sharp(baseJpg).withExif({ IFD0: { Make: 'NIKON CORPORATION', Model: 'NIKON D850' } }).jpeg().toBuffer()
    expect(await detectAiSignal(jpg, 'image/jpeg')).toBeNull()
    expect(await detectAiSignal(basePng, 'image/png')).toBeNull()
    expect(await detectAiSignal(baseWebp, 'image/webp')).toBeNull()
  })

  it('never throws on a file it cannot parse — an unreadable upload is simply no evidence', async () => {
    expect(await detectAiSignal(Buffer.from('%PDF-1.4\nnot an image'), 'application/pdf')).toBeNull()
    expect(await detectAiSignal(Buffer.alloc(0), 'image/png')).toBeNull()
    expect(await detectAiSignal(basePng.subarray(0, 20), 'image/png')).toBeNull()
    expect(await detectAiSignal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).toBeNull()
  })
})
