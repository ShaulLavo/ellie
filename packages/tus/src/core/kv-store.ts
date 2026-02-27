/**
 * Key-value store interfaces and implementations for upload metadata persistence.
 * Adapted from tus-node-server (MIT) — see ATTRIBUTION.md
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Upload } from './upload'

export interface KvStore<T = Upload> {
	get(key: string): Promise<T | undefined>
	set(key: string, value: T): Promise<void>
	delete(key: string): Promise<void>
	list?(): Promise<Array<string>>
}

export class FileKvStore<T = Upload> implements KvStore<T> {
	directory: string

	constructor(dir: string) {
		this.directory = dir
	}

	async get(key: string): Promise<T | undefined> {
		try {
			const buffer = await fs.readFile(
				this.resolve(key),
				'utf8'
			)
			return JSON.parse(buffer)
		} catch {
			return undefined
		}
	}

	async set(key: string, value: T): Promise<void> {
		await fs.writeFile(
			this.resolve(key),
			JSON.stringify(value)
		)
	}

	async delete(key: string): Promise<void> {
		await fs.rm(this.resolve(key))
	}

	async list(): Promise<Array<string>> {
		const files = await fs.readdir(this.directory)
		const sorted = files.sort((a, b) => a.localeCompare(b))
		const name = (file: string) =>
			path.basename(file, '.json')
		// Only return tus file IDs — check if the file has a corresponding JSON info file
		return sorted.filter(
			(file, idx) =>
				idx < sorted.length - 1 &&
				name(file) === name(sorted[idx + 1])
		)
	}

	private resolve(key: string): string {
		return path.resolve(this.directory, `${key}.json`)
	}
}

export class MemoryKvStore<
	T = Upload
> implements KvStore<T> {
	data: Map<string, T> = new Map()

	async get(key: string): Promise<T | undefined> {
		return this.data.get(key)
	}

	async set(key: string, value: T): Promise<void> {
		this.data.set(key, value)
	}

	async delete(key: string): Promise<void> {
		this.data.delete(key)
	}

	async list(): Promise<Array<string>> {
		return [...this.data.keys()]
	}
}
