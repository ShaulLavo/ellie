/**
 * DataStore interface — abstract base for tus storage backends.
 * Adapted from tus-node-server (MIT) — see ATTRIBUTION.md
 */

import type { Readable } from 'node:stream'
import { Upload } from './upload'

export abstract class DataStore {
	extensions: string[] = []

	hasExtension(extension: string): boolean {
		return this.extensions.includes(extension)
	}

	async create(file: Upload): Promise<Upload> {
		return file
	}

	async remove(_id: string): Promise<void> {}

	async write(
		_stream: Readable,
		_id: string,
		_offset: number
	): Promise<number> {
		return 0
	}

	async getUpload(id: string): Promise<Upload> {
		return new Upload({
			id,
			size: 0,
			offset: 0,
			storage: { type: 'datastore', path: '' }
		})
	}

	async declareUploadLength(
		_id: string,
		_upload_length: number
	): Promise<void> {}

	async deleteExpired(): Promise<number> {
		return 0
	}

	getExpiration(): number {
		return 0
	}
}
