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
		} catch (err: unknown) {
			if (
				err &&
				typeof err === 'object' &&
				'code' in err &&
				err.code === 'ENOENT'
			) {
				return undefined
			}
			throw err
		}
	}

	async set(key: string, value: T): Promise<void> {
		await fs.writeFile(
			this.resolve(key),
			JSON.stringify(value)
		)
	}

	async delete(key: string): Promise<void> {
		await fs.rm(this.resolve(key), { force: true })
	}

	async list(): Promise<Array<string>> {
		const files = await fs.readdir(this.directory)
		const jsonFiles = new Set<string>()
		for (const file of files) {
			if (file.endsWith('.json')) {
				jsonFiles.add(path.basename(file, '.json'))
			}
		}
		return [...jsonFiles].sort((a, b) => a.localeCompare(b))
	}

	private resolve(key: string): string {
		// Sanitize key to prevent path traversal
		if (key.includes('..') || path.isAbsolute(key)) {
			throw new Error(
				`Invalid key: ${key} (must not contain ".." or be an absolute path)`
			)
		}
		const sanitized = key.replace(/^[/\\]+/, '')
		const finalPath = path.resolve(
			this.directory,
			`${sanitized}.json`
		)
		const base = path.resolve(this.directory)
		if (!finalPath.startsWith(base + path.sep)) {
			throw new Error(
				`Invalid key: resolved path escapes base directory`
			)
		}
		return finalPath
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
