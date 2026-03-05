/**
 * DataStore interface — abstract base for tus storage backends.
 * Adapted from tus-node-server (MIT) — see ATTRIBUTION.md
 */

import type { Readable } from 'node:stream'
import type { Upload } from './upload'

export abstract class DataStore {
	extensions: string[] = []

	hasExtension(extension: string): boolean {
		return this.extensions.includes(extension)
	}

	abstract create(file: Upload): Promise<Upload>

	abstract remove(id: string): Promise<void>

	abstract write(
		stream: Readable,
		id: string,
		offset: number
	): Promise<number>

	abstract getUpload(id: string): Promise<Upload>

	abstract declareUploadLength(
		id: string,
		upload_length: number
	): Promise<void>

	async deleteExpired(): Promise<number> {
		return 0
	}

	getExpiration(): number {
		return 0
	}
}
