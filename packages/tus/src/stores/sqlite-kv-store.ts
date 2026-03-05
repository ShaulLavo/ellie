/**
 * SQLite-backed KvStore for upload metadata.
 * Replaces per-upload JSON files with a single SQLite database.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { KvStore } from '../core/kv-store'
import type { Upload } from '../core/upload'

export class SqliteKvStore implements KvStore<Upload> {
	private db: Database

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true })
		this.db = new Database(dbPath)
		this.db.run('PRAGMA journal_mode=WAL')
		this.db.run(`
			CREATE TABLE IF NOT EXISTS uploads (
				id   TEXT PRIMARY KEY,
				data TEXT NOT NULL
			)
		`)
	}

	async get(key: string): Promise<Upload | undefined> {
		const row = this.db
			.query<{ data: string }, [string]>(
				'SELECT data FROM uploads WHERE id = ?'
			)
			.get(key)
		if (!row) return undefined
		try {
			return JSON.parse(row.data) as Upload
		} catch {
			return undefined
		}
	}

	async set(key: string, value: Upload): Promise<void> {
		this.db.run(
			'INSERT OR REPLACE INTO uploads (id, data) VALUES (?, ?)',
			[key, JSON.stringify(value)]
		)
	}

	async delete(key: string): Promise<void> {
		this.db.run('DELETE FROM uploads WHERE id = ?', [key])
	}

	async list(): Promise<string[]> {
		const rows = this.db
			.query<{ id: string }, []>(
				'SELECT id FROM uploads ORDER BY id'
			)
			.all()
		return rows.map(r => r.id)
	}
}
