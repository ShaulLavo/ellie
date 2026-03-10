/**
 * TUS-backed blob sink — writes blobs directly to a FileStore.
 *
 * Uses direct store writes (not HTTP self-uploads). Internal blob IDs
 * are path-style and trace-scoped:
 *   trace/<traceId>/<spanId>/<role>/<ulid>.<ext>
 *
 * Fails closed: if the write fails, the error propagates — no silent catch.
 */

import { Readable } from 'node:stream'
import { ulid } from 'fast-ulid'
import { hash } from 'ohash'
import { Upload } from '@ellie/tus'
import type { FileStore } from '@ellie/tus'
import type {
	BlobRef,
	BlobSink,
	BlobWriteOptions
} from './types'

/** Payloads larger than this threshold should be stored as blobs. */
export const BLOB_THRESHOLD = 64 * 1024 // 64 KB

/**
 * Determine whether content should be stored as a blob.
 *
 * Returns true when:
 * - Content is binary (Buffer)
 * - Content was truncated for model context
 * - Raw text/JSON exceeds BLOB_THRESHOLD
 */
export function shouldBlob(
	content: string | Buffer,
	wasTruncated?: boolean
): boolean {
	if (Buffer.isBuffer(content)) return true
	if (wasTruncated) return true
	return (
		Buffer.byteLength(content, 'utf-8') > BLOB_THRESHOLD
	)
}

/**
 * TUS-backed BlobSink implementation.
 *
 * Writes blobs to the same FileStore used by the TUS upload server,
 * making them accessible via the existing TUS RPC surface.
 */
export class TusBlobSink implements BlobSink {
	readonly #fileStore: FileStore

	constructor(fileStore: FileStore) {
		this.#fileStore = fileStore
	}

	async write(opts: BlobWriteOptions): Promise<BlobRef> {
		const {
			traceId,
			spanId,
			role,
			content,
			mimeType,
			ext
		} = opts

		// Build the path-style upload ID
		const blobId = ulid()
		const storagePath = `trace/${traceId}/${spanId}/${role}/${blobId}.${ext}`

		// Compute fingerprint
		const contentBuf = Buffer.isBuffer(content)
			? content
			: Buffer.from(content, 'utf-8')
		const fingerprint = hash(contentBuf)
		const sizeBytes = contentBuf.length

		// Create the upload entry in the FileStore
		const upload = new Upload({
			id: storagePath,
			size: sizeBytes,
			offset: 0,
			metadata: {
				mimeType,
				role,
				traceId,
				spanId,
				ohash: fingerprint
			}
		})

		await this.#fileStore.create(upload)

		// Write the content
		const readable = Readable.from(contentBuf)
		await this.#fileStore.write(readable, storagePath, 0)

		// Build preview for inline display
		let preview: string | undefined
		if (!Buffer.isBuffer(content) && content.length > 0) {
			preview = content.slice(0, 2000)
			if (content.length > 2000) {
				preview += `\n\n[... ${content.length - 2000} more chars]`
			}
		}

		return {
			uploadId: storagePath,
			url: `/api/uploads-rpc/${encodeURIComponent(storagePath)}/content`,
			storagePath,
			mimeType,
			sizeBytes,
			ohash: fingerprint,
			role,
			preview
		}
	}
}
