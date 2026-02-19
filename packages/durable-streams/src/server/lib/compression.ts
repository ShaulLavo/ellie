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

export function compressData(
  data: Uint8Array,
  encoding: `gzip` | `deflate`
): Uint8Array {
  if (encoding === `gzip`) {
    return Bun.gzipSync(data)
  } else {
    return Bun.deflateSync(data)
  }
}
