import { eden } from '@/lib/eden'

// ── Unwrap Eden response ─────────────────────────────────────────────────────

function unwrap<T>(result: {
	data: T | null
	error: { value: unknown } | null
}): T {
	if (result.error) {
		const msg =
			result.error.value &&
			typeof result.error.value === 'object' &&
			'error' in result.error.value
				? String(
						(result.error.value as { error: string }).error
					)
				: 'Request failed'
		throw new Error(msg)
	}
	return result.data as T
}

// ── API helpers (Eden RPC) ───────────────────────────────────────────────────

export async function fetchDatabases() {
	const res = await eden.db.databases.get()
	return unwrap(res)
}

export async function fetchTables(database: string) {
	const res = await eden.db({ database }).tables.get()
	return unwrap(res)
}

export async function fetchSchema(
	database: string,
	table: string
) {
	const res = await eden
		.db({ database })({ table })
		.schema.get()
	return unwrap(res)
}

export async function fetchRows(
	database: string,
	table: string,
	opts: {
		page?: number
		pageSize?: number
		sortBy?: string
		sortDir?: 'asc' | 'desc'
		filter?: string
	} = {}
) {
	const res = await eden
		.db({ database })({ table })
		.get({
			query: {
				page: opts.page as number,
				pageSize: opts.pageSize as number,
				sortBy: opts.sortBy,
				sortDir: opts.sortDir,
				filter: opts.filter
			}
		})
	return unwrap(res)
}
