export const COMPRESSION_THRESHOLD = 1024

export function getCompressionEncoding(
  acceptEncoding: string | undefined
): `gzip` | `deflate` | null {
  if (!acceptEncoding) return null

  const encodings = acceptEncoding
    .toLowerCase()
    .split(`,`)
    .map((e) => e.trim())

  for (const encoding of encodings) {
    const parts = encoding.split(`;`)
    const name = parts[0]?.trim()
    if (name === `gzip` && !hasQZero(parts)) return `gzip`
  }
  for (const encoding of encodings) {
    const parts = encoding.split(`;`)
    const name = parts[0]?.trim()
    if (name === `deflate` && !hasQZero(parts)) return `deflate`
  }

  return null
}

function hasQZero(parts: string[]): boolean {
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i]!.trim()
    if (param.startsWith(`q=`)) {
      return parseFloat(param.slice(2)) === 0
    }
  }
  return false
}

export async function compressData(
  data: Uint8Array,
  encoding: `gzip` | `deflate`
): Promise<Uint8Array> {
  const cs = new CompressionStream(encoding)
  const writer = cs.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  const reader = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    totalLength += value.length
  }
  if (chunks.length === 1) return chunks[0]!
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
