import sharp from 'sharp'
import { rgbaToThumbHash } from '@ellie/utils'

export async function generateThumbHash(
	imageBytes: Buffer
): Promise<string> {
	const { data, info } = await sharp(imageBytes)
		.resize(100, 100, { fit: 'inside' })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })
	const hash = rgbaToThumbHash(
		info.width,
		info.height,
		new Uint8Array(data)
	)
	return Buffer.from(hash).toString('base64')
}
