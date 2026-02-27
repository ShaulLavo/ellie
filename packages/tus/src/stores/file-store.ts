/**
 * Filesystem-backed tus DataStore.
 * Adapted from tus-node-server @tus/file-store (MIT) — see ATTRIBUTION.md
 */

import * as fs from 'node:fs'
import * as fsProm from 'node:fs/promises'
import * as path from 'node:path'
import * as stream from 'node:stream'

import { DataStore } from '../core/data-store'
import { Upload } from '../core/upload'
import { ERRORS } from '../core/constants'
import { FileKvStore, type KvStore } from '../core/kv-store'

type FileStoreOptions = {
	directory: string
	configstore?: KvStore<Upload>
	expirationPeriodInMilliseconds?: number
}

const FILE_DOESNT_EXIST = 'ENOENT'

export class FileStore extends DataStore {
	directory: string
	configstore: KvStore<Upload>
	expirationPeriodInMilliseconds: number

	constructor(options: FileStoreOptions) {
		super()
		this.directory = options.directory
		this.configstore =
			options.configstore ??
			new FileKvStore(options.directory)
		this.expirationPeriodInMilliseconds =
			options.expirationPeriodInMilliseconds ?? 0
		this.extensions = [
			'creation',
			'creation-with-upload',
			'creation-defer-length',
			'termination',
			'expiration'
		]
		fs.mkdirSync(this.directory, {
			mode: 0o755,
			recursive: true
		})
	}

	async create(file: Upload): Promise<Upload> {
		const dirs = file.id.split('/').slice(0, -1)
		const filePath = path.join(this.directory, file.id)

		await fsProm.mkdir(path.join(this.directory, ...dirs), {
			recursive: true
		})
		await fsProm.writeFile(filePath, '')
		await this.configstore.set(file.id, file)

		file.storage = { type: 'file', path: filePath }
		return file
	}

	read(file_id: string): fs.ReadStream {
		return fs.createReadStream(
			path.join(this.directory, file_id)
		)
	}

	async remove(file_id: string): Promise<void> {
		const filePath = path.join(this.directory, file_id)
		try {
			await fsProm.unlink(filePath)
		} catch {
			throw ERRORS.FILE_NOT_FOUND
		}
		await this.configstore.delete(file_id)
	}

	async write(
		readable: stream.Readable,
		file_id: string,
		offset: number
	): Promise<number> {
		const file_path = path.join(this.directory, file_id)
		const writeable = fs.createWriteStream(file_path, {
			flags: 'r+',
			start: offset
		})

		let bytes_received = 0
		const transform = new stream.Transform({
			transform(chunk, _, callback) {
				bytes_received += chunk.length
				callback(null, chunk)
			}
		})

		return new Promise((resolve, reject) => {
			stream.pipeline(
				readable,
				transform,
				writeable,
				err => {
					if (err) {
						return reject(ERRORS.FILE_WRITE_ERROR)
					}
					offset += bytes_received
					return resolve(offset)
				}
			)
		})
	}

	async getUpload(id: string): Promise<Upload> {
		const file = await this.configstore.get(id)

		if (!file) {
			throw ERRORS.FILE_NOT_FOUND
		}

		const file_path = path.join(this.directory, id)
		let stats: fs.Stats
		try {
			stats = await fsProm.stat(file_path)
		} catch (error: unknown) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				error.code === FILE_DOESNT_EXIST
			) {
				throw ERRORS.FILE_NO_LONGER_EXISTS
			}
			throw error
		}

		if (stats.isDirectory()) {
			throw ERRORS.FILE_NOT_FOUND
		}

		return new Upload({
			id,
			size: file.size,
			offset: stats.size,
			metadata: file.metadata,
			creation_date: file.creation_date,
			storage: {
				type: 'file',
				path: file_path
			}
		})
	}

	async declareUploadLength(
		id: string,
		upload_length: number
	): Promise<void> {
		const file = await this.configstore.get(id)

		if (!file) {
			throw ERRORS.FILE_NOT_FOUND
		}

		file.size = upload_length
		await this.configstore.set(id, file)
	}

	async deleteExpired(): Promise<number> {
		const now = new Date()
		const toDelete: Promise<void>[] = []

		if (!this.configstore.list) {
			throw ERRORS.UNSUPPORTED_EXPIRATION_EXTENSION
		}

		const uploadKeys = await this.configstore.list()
		for (const file_id of uploadKeys) {
			try {
				const info = await this.configstore.get(file_id)
				if (
					info &&
					'creation_date' in info &&
					this.getExpiration() > 0 &&
					info.size !== info.offset &&
					info.creation_date
				) {
					const creation = new Date(info.creation_date)
					const expires = new Date(
						creation.getTime() + this.getExpiration()
					)
					if (now > expires) {
						toDelete.push(this.remove(file_id))
					}
				}
			} catch (error) {
				if (error !== ERRORS.FILE_NO_LONGER_EXISTS) {
					throw error
				}
			}
		}

		await Promise.all(toDelete)
		return toDelete.length
	}

	getExpiration(): number {
		return this.expirationPeriodInMilliseconds
	}
}
