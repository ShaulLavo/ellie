/** Extract width/height from common image format headers (PNG, GIF, WebP, JPEG). */
export function extractImageDimensions(
	buf: Buffer
): { width: number; height: number } | undefined {
	// PNG: bytes 16-23 contain width (4 bytes BE) and height (4 bytes BE) in IHDR
	if (
		buf.length >= 24 &&
		buf[0] === 0x89 &&
		buf[1] === 0x50
	) {
		return {
			width: buf.readUInt32BE(16),
			height: buf.readUInt32BE(20)
		}
	}

	// GIF: bytes 6-9 contain width and height (2 bytes LE each)
	if (
		buf.length >= 10 &&
		buf[0] === 0x47 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46
	) {
		return {
			width: buf.readUInt16LE(6),
			height: buf.readUInt16LE(8)
		}
	}

	// WebP: RIFF....WEBP header, then VP8 chunk
	if (
		buf.length >= 30 &&
		buf.toString('ascii', 0, 4) === 'RIFF' &&
		buf.toString('ascii', 8, 12) === 'WEBP'
	) {
		// VP8 (lossy)
		if (buf.toString('ascii', 12, 15) === 'VP8') {
			if (buf[15] === 0x20 && buf.length >= 30) {
				return {
					width: buf.readUInt16LE(26) & 0x3fff,
					height: buf.readUInt16LE(28) & 0x3fff
				}
			}
			// VP8L (lossless)
			if (buf[15] === 0x4c && buf.length >= 25) {
				const bits = buf.readUInt32LE(21)
				return {
					width: (bits & 0x3fff) + 1,
					height: ((bits >> 14) & 0x3fff) + 1
				}
			}
		}
	}

	// JPEG: scan for SOF0/SOF2 marker
	if (
		buf.length >= 2 &&
		buf[0] === 0xff &&
		buf[1] === 0xd8
	) {
		let offset = 2
		while (offset < buf.length - 1) {
			if (buf[offset] !== 0xff) break
			const marker = buf[offset + 1]
			if (
				(marker >= 0xc0 &&
					marker <= 0xc3 &&
					offset + 9 < buf.length) ||
				(marker === 0xc5 && offset + 9 < buf.length)
			) {
				return {
					height: buf.readUInt16BE(offset + 5),
					width: buf.readUInt16BE(offset + 7)
				}
			}
			if (marker === 0xd9 || marker === 0xda) break
			const segLen = buf.readUInt16BE(offset + 2)
			offset += 2 + segLen
		}
	}

	return undefined
}
