/**
 * Minimal TUS upload client — single-shot (no chunking/resumption).
 * Uses raw fetch against the existing /api/uploads TUS endpoints.
 */

import { env } from '@ellie/env/client'

export interface UploadResult {
	uploadId: string
	mime: string
	size: number
	name: string
}

const tusEndpoint = `${env.API_BASE_URL.replace(/\/$/, '')}/api/uploads`

function encodeMeta(value: string): string {
	return btoa(unescape(encodeURIComponent(value)))
}

export async function uploadFile(
	file: File
): Promise<UploadResult> {
	const mime = file.type || 'application/octet-stream'
	const metadata = [
		`filename ${encodeMeta(file.name)}`,
		`mimeType ${encodeMeta(mime)}`
	].join(',')

	// 1. POST — create upload
	const createRes = await fetch(tusEndpoint, {
		method: 'POST',
		headers: {
			'Tus-Resumable': '1.0.0',
			'Upload-Length': String(file.size),
			'Upload-Metadata': metadata,
			'Content-Length': '0'
		}
	})
	if (!createRes.ok) {
		throw new Error(
			`Upload create failed: ${createRes.status}`
		)
	}

	const location = createRes.headers.get('Location')
	if (!location)
		throw new Error('Upload create: no Location header')

	const uploadId = location.split('/').pop()!
	const patchUrl = location.startsWith('http')
		? location
		: `${env.API_BASE_URL.replace(/\/$/, '')}${location}`

	// 2. PATCH — send file body
	const patchRes = await fetch(patchUrl, {
		method: 'PATCH',
		headers: {
			'Tus-Resumable': '1.0.0',
			'Upload-Offset': '0',
			'Content-Type': 'application/offset+octet-stream'
		},
		body: file
	})
	if (!patchRes.ok) {
		throw new Error(
			`Upload patch failed: ${patchRes.status}`
		)
	}

	return {
		uploadId,
		mime,
		size: file.size,
		name: file.name
	}
}

export function uploadFiles(
	files: File[]
): Promise<UploadResult[]> {
	return Promise.all(files.map(uploadFile))
}
