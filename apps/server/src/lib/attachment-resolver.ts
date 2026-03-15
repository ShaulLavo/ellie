/**
 * Utilities for resolving uploaded file attachments into typed content parts.
 */

import type { FileStore } from '@ellie/tus'

/** Read a TUS upload into a Buffer. */
export async function readUploadBytes(
	uploadStore: FileStore,
	uploadId: string
): Promise<Buffer> {
	const stream = uploadStore.read(uploadId)
	const chunks: Uint8Array[] = []
	for await (const chunk of stream) {
		chunks.push(
			chunk instanceof Uint8Array
				? chunk
				: new Uint8Array(chunk as ArrayBuffer)
		)
	}
	return Buffer.concat(chunks)
}

/** MIME prefixes that represent text-based content the model can read. */
export const TEXT_MIME_PREFIXES = [
	'text/',
	'application/json',
	'application/xml',
	'application/javascript',
	'application/typescript',
	'application/x-yaml',
	'application/toml',
	'application/sql'
]

/** Extensions browsers commonly misidentify (e.g. .ts -> video/mp2t). */
export const TEXT_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.json',
	'.yaml',
	'.yml',
	'.toml',
	'.xml',
	'.md',
	'.mdx',
	'.txt',
	'.csv',
	'.tsv',
	'.html',
	'.htm',
	'.css',
	'.scss',
	'.less',
	'.py',
	'.rb',
	'.rs',
	'.go',
	'.java',
	'.kt',
	'.c',
	'.h',
	'.cpp',
	'.hpp',
	'.cs',
	'.swift',
	'.sh',
	'.bash',
	'.zsh',
	'.fish',
	'.sql',
	'.graphql',
	'.gql',
	'.env',
	'.ini',
	'.cfg',
	'.conf',
	'.vue',
	'.svelte',
	'.astro'
])

/** Check if a MIME type represents text-based content the model can read. */
export function isTextContent(
	mime: string,
	filename?: string
): boolean {
	if (TEXT_MIME_PREFIXES.some(p => mime.startsWith(p)))
		return true
	if (filename) {
		const ext = filename
			.slice(filename.lastIndexOf('.'))
			.toLowerCase()
		if (TEXT_EXTENSIONS.has(ext)) return true
	}
	return false
}
