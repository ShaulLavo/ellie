import { join } from 'path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { openDatabase } from '@ellie/db'
import type { Database } from 'bun:sqlite'
import * as schema from './schema'

const MIGRATIONS_DIR = join(
	import.meta.dir,
	'..',
	'drizzle'
)

export type HindsightDB = ReturnType<
	typeof drizzle<typeof schema>
>

export interface HindsightDatabase {
	db: HindsightDB
	sqlite: Database
	schema: typeof schema
}

/**
 * Create and initialize the hindsight database.
 *
 * Uses `openDatabase()` from @ellie/db which handles sqlite-vec loading.
 * Creates Drizzle-managed tables via migrations + virtual tables (FTS5, vec0) via raw DDL.
 */
export function createHindsightDB(
	dbPath: string,
	embeddingDims: number
): HindsightDatabase {
	const sqlite = openDatabase(dbPath)
	const db = drizzle(sqlite, { schema })

	// Apply Drizzle migrations for structured tables
	migrate(db, { migrationsFolder: MIGRATIONS_DIR })

	// FTS5 virtual table for BM25 full-text search
	sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hs_memory_fts
    USING fts5(id UNINDEXED, bank_id UNINDEXED, content, tokenize='porter')
  `)

	// sqlite-vec virtual tables for vector similarity search
	sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hs_memory_vec
    USING vec0(id TEXT PRIMARY KEY, embedding float[${embeddingDims}])
  `)
	sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hs_entity_vec
    USING vec0(id TEXT PRIMARY KEY, embedding float[${embeddingDims}])
  `)
	sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hs_mental_model_vec
    USING vec0(id TEXT PRIMARY KEY, embedding float[${embeddingDims}])
  `)

	// Phase 4: visual memory embeddings
	sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hs_visual_vec
    USING vec0(id TEXT PRIMARY KEY, embedding float[${embeddingDims}])
  `)

	return { db, sqlite, schema }
}
