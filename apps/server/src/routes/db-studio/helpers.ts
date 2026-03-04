import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

// ── System / shadow table detection ─────────────────────────────────────────

const SYSTEM_PATTERNS = [/^sqlite_/, /^_cf_/]

const FTS_SHADOW_SUFFIXES = [
	'_content',
	'_segments',
	'_segdir',
	'_docsize',
	'_stat',
	'_config',
	'_data',
	'_idx'
]
const VEC_SHADOW_SUFFIXES = [
	'_chunks',
	'_rowids',
	'_vector_chunks00'
]

function isSystemTable(name: string): boolean {
	return SYSTEM_PATTERNS.some(p => p.test(name))
}

function isShadowTable(
	name: string,
	allNames: string[]
): boolean {
	for (const suffix of [
		...FTS_SHADOW_SUFFIXES,
		...VEC_SHADOW_SUFFIXES
	]) {
		if (name.endsWith(suffix)) {
			const parent = name.slice(0, -suffix.length)
			if (allNames.includes(parent)) return true
		}
	}
	return false
}

// ── SQL helpers ─────────────────────────────────────────────────────────────

/** Double-quote an identifier to prevent injection. */
export function quoteId(name: string): string {
	return `"${name.replace(/"/g, '""')}"`
}

// ── Filter parsing ──────────────────────────────────────────────────────────

type FilterOp = 'eq' | 'contains' | 'gt' | 'lt'

interface ParsedFilter {
	column: string
	op: FilterOp
	value: string
}

export function parseFilter(raw: string): ParsedFilter {
	const parts = raw.split(':')
	if (parts.length < 3) {
		throw new Error(
			`Invalid filter format. Expected column:operator:value`
		)
	}
	const column = parts[0]
	const op = parts[1]
	const value = parts.slice(2).join(':') // value may contain colons

	if (!['eq', 'contains', 'gt', 'lt'].includes(op)) {
		throw new Error(
			`Invalid filter operator: ${op}. Expected eq|contains|gt|lt`
		)
	}

	return { column, op: op as FilterOp, value }
}

export function buildFilterClause(filter: ParsedFilter): {
	sql: string
	params: string[]
} {
	const col = quoteId(filter.column)
	switch (filter.op) {
		case 'eq':
			return { sql: `${col} = ?`, params: [filter.value] }
		case 'contains':
			return {
				sql: `${col} LIKE ?`,
				params: [`%${filter.value}%`]
			}
		case 'gt':
			return { sql: `${col} > ?`, params: [filter.value] }
		case 'lt':
			return { sql: `${col} < ?`, params: [filter.value] }
	}
}

// ── Database operations ─────────────────────────────────────────────────────

export function discoverDbs(dataDir: string): Array<{
	name: string
	sizeBytes: number
	updatedAt: string
}> {
	try {
		return readdirSync(dataDir)
			.filter(
				f =>
					f.endsWith('.db') &&
					!f.endsWith('-wal') &&
					!f.endsWith('-shm')
			)
			.map(f => {
				const stat = statSync(resolve(dataDir, f))
				return {
					name: f,
					sizeBytes: stat.size,
					updatedAt: stat.mtime.toISOString()
				}
			})
			.sort((a, b) => a.name.localeCompare(b.name))
	} catch {
		return []
	}
}

export function openDb(
	dataDir: string,
	name: string,
	cache: Map<string, Database>
): Database {
	const allowed = new Set(
		discoverDbs(dataDir).map(d => d.name)
	)
	if (!allowed.has(name)) {
		throw new Error(`Database not found: ${name}`)
	}
	let db = cache.get(name)
	if (!db) {
		db = new Database(resolve(dataDir, name), {
			readonly: true
		})
		cache.set(name, db)
	}
	return db
}

export function getTables(db: Database): Array<{
	name: string
	type: 'table' | 'view'
	isVirtual: boolean
}> {
	const rows = db
		.query(
			`SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`
		)
		.all() as Array<{
		name: string
		type: string
		sql: string | null
	}>

	const allNames = rows.map(r => r.name)

	return rows
		.filter(
			r =>
				!isSystemTable(r.name) &&
				!isShadowTable(r.name, allNames)
		)
		.map(r => ({
			name: r.name,
			type: r.type as 'table' | 'view',
			isVirtual: r.sql
				? /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql)
				: false
		}))
}

export function getSchema(db: Database, table: string) {
	// Verify table exists
	const exists = db
		.query(
			`SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')`
		)
		.get(table)
	if (!exists) {
		throw new Error(`Table not found: ${table}`)
	}

	// Columns via table_xinfo (includes hidden columns)
	const cols = db
		.query(`PRAGMA table_xinfo(${quoteId(table)})`)
		.all() as Array<{
		cid: number
		name: string
		type: string
		notnull: number
		dflt_value: string | null
		pk: number
		hidden: number
	}>

	// Unique columns via index_list + index_info
	const uniqueCols = new Set<string>()
	try {
		const indexes = db
			.query(`PRAGMA index_list(${quoteId(table)})`)
			.all() as Array<{
			name: string
			unique: number
		}>
		for (const idx of indexes) {
			if (idx.unique) {
				const idxCols = db
					.query(`PRAGMA index_info(${quoteId(idx.name)})`)
					.all() as Array<{ name: string }>
				if (idxCols.length === 1) {
					uniqueCols.add(idxCols[0].name)
				}
			}
		}
	} catch {
		// Virtual tables may not support index introspection
	}

	// Foreign keys
	let foreignKeys: Array<{
		from: string
		to: string
		targetTable: string
		onUpdate: string
		onDelete: string
	}> = []
	try {
		const fks = db
			.query(`PRAGMA foreign_key_list(${quoteId(table)})`)
			.all() as Array<{
			table: string
			from: string
			to: string
			on_update: string
			on_delete: string
		}>
		foreignKeys = fks.map(fk => ({
			from: fk.from,
			to: fk.to,
			targetTable: fk.table,
			onUpdate: fk.on_update,
			onDelete: fk.on_delete
		}))
	} catch {
		// Virtual tables may not support FK introspection
	}

	return {
		columns: cols.map(c => ({
			name: c.name,
			type: c.type || 'ANY',
			notNull: c.notnull === 1,
			primaryKey: c.pk > 0,
			defaultValue: c.dflt_value,
			unique: uniqueCols.has(c.name),
			hidden: c.hidden > 0
		})),
		foreignKeys
	}
}
