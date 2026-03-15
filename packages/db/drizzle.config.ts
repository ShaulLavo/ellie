import { resolve } from 'node:path'
import type { Config } from 'drizzle-kit'

const DATA_DIR = resolve(
	process.env.DATA_DIR ?? '../../data'
)

export default {
	schema: './src/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: `${DATA_DIR}/events.db`
	}
} satisfies Config
