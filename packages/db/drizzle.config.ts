import { resolve } from 'node:path'
import type { Config } from 'drizzle-kit'

/** Monorepo root — two levels up from packages/db/ */
const MONOREPO_ROOT = resolve(import.meta.dir, '../..')
const DATA_DIR = resolve(
	MONOREPO_ROOT,
	process.env.DATA_DIR ?? './data'
)

export default {
	schema: './src/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: `${DATA_DIR}/events.db`
	}
} satisfies Config
