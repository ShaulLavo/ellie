import { sql } from 'drizzle-orm'
import type { HindsightDatabase } from './db'

/** Insert a memory into the FTS5 full-text index. */
export function ftsInsert(
	hdb: HindsightDatabase,
	id: string,
	bankId: string,
	content: string
): void {
	hdb.db.run(
		sql`INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (${id}, ${bankId}, ${content})`
	)
}

/** Delete a memory from the FTS5 full-text index. */
export function ftsDelete(
	hdb: HindsightDatabase,
	id: string
): void {
	hdb.db.run(
		sql`DELETE FROM hs_memory_fts WHERE id = ${id}`
	)
}

/** Replace a memory's content in the FTS5 index (delete + re-insert). */
export function ftsReplace(
	hdb: HindsightDatabase,
	id: string,
	bankId: string,
	newContent: string
): void {
	ftsDelete(hdb, id)
	ftsInsert(hdb, id, bankId, newContent)
}

/** Delete all FTS entries for a bank. */
export function ftsDeleteBank(
	hdb: HindsightDatabase,
	bankId: string
): void {
	hdb.db.run(
		sql`DELETE FROM hs_memory_fts WHERE bank_id = ${bankId}`
	)
}
