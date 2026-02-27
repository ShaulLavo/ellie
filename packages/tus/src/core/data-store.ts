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

	async create(_file: Upload): Promise<Upload> {
		throw new Error(
			`[${this.constructor.name}] Method create() must be implemented by subclass`
		)
	}

	async remove(_id: string): Promise<void> {
		throw new Error(
			`[${this.constructor.name}] Method remove() must be implemented by subclass`
		)
	}

	async write(
		_stream: Readable,
		_id: string,
		_offset: number
	): Promise<number> {
		throw new Error(
			`[${this.constructor.name}] Method write() must be implemented by subclass`
		)
	}

	async getUpload(_id: string): Promise<Upload> {
		throw new Error(
			`[${this.constructor.name}] Method getUpload() must be implemented by subclass`
		)
	}

	async declareUploadLength(
		_id: string,
		_upload_length: number
	): Promise<void> {
		throw new Error(
			`[${this.constructor.name}] Method declareUploadLength() must be implemented by subclass`
		)
	}

	async deleteExpired(): Promise<number> {
		return 0
	}

	getExpiration(): number {
		return 0
	}
}
