/**
 * DB Studio — read-only, multi-database SQLite explorer.
 *
 * Discovers `.db` files in DATA_DIR and exposes:
 *   GET /api/db/databases           — list available databases
 *   GET /api/db/:database/tables    — list tables/views (system/shadow hidden)
 *   GET /api/db/:database/:table/schema — column types, constraints, FKs
 *   GET /api/db/:database/:table    — paginated rows with sort/filter
 */

import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import {
	discoverDbs,
	openDb,
	getTables,
	getSchema,
	quoteId,
	parseFilter,
	buildFilterClause
} from './helpers'
import {
	dbParamsSchema,
	dbTableParamsSchema,
	rowsQuerySchema
} from './schemas'
import {
	BadRequestError,
	NotFoundError
} from '../http-errors'
import { requireLoopback } from '../loopback-guard'

function queryTableRows(
	dataDir: string,
	dbCache: Map<string, Database>,
	params: { database: string; table: string },
	query: {
		page?: number
		pageSize?: number
		sortBy?: string
		sortDir?: string
		filter?: string
	}
) {
	const db = openDb(dataDir, params.database, dbCache)
	const { table } = params
	const page = query.page ?? 1
	const pageSize = query.pageSize ?? 100

	const exists = db
		.query(
			`SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')`
		)
		.get(table)
	if (!exists) {
		throw new NotFoundError(`Table not found: ${table}`)
	}

	let sortBy = query.sortBy ?? null
	if (sortBy) {
		const schema = getSchema(db, table)
		const validCols = new Set(
			schema.columns.map(c => c.name)
		)
		if (!validCols.has(sortBy)) {
			throw new BadRequestError(
				`Invalid sort column: ${sortBy}`
			)
		}
	}

	const sortDir = query.sortDir === 'desc' ? 'DESC' : 'ASC'

	let filterClause = ''
	let filterParams: string[] = []
	const filterRaw = query.filter ?? null
	if (filterRaw) {
		const parsed = parseFilter(filterRaw)
		const schema = getSchema(db, table)
		const validCols = new Set(
			schema.columns.map(c => c.name)
		)
		if (!validCols.has(parsed.column)) {
			throw new BadRequestError(
				`Invalid filter column: ${parsed.column}`
			)
		}
		const clause = buildFilterClause(parsed)
		filterClause = `WHERE ${clause.sql}`
		filterParams = clause.params
	}

	const pg = Number(page)
	const ps = Number(pageSize)

	const countRow = db
		.query(
			`SELECT COUNT(*) as cnt FROM ${quoteId(table)} ${filterClause}`
		)
		.get(...filterParams) as { cnt: number }
	const totalRows = countRow.cnt

	const totalPages = Math.max(1, Math.ceil(totalRows / ps))

	const orderClause = sortBy
		? `ORDER BY ${quoteId(sortBy)} ${sortDir}`
		: ''
	const offset = (pg - 1) * ps

	const rows = db
		.query(
			`SELECT * FROM ${quoteId(table)} ${filterClause} ${orderClause} LIMIT ? OFFSET ?`
		)
		.all(...filterParams, ps, offset) as Array<
		Record<string, unknown>
	>

	return {
		database: params.database,
		table,
		page,
		pageSize,
		totalRows,
		totalPages,
		sortBy,
		sortDir: (query.sortDir ?? 'asc') as 'asc' | 'desc',
		filter: filterRaw,
		rows
	}
}

export function createDbStudioRoutes(dataDir: string) {
	const dbCache = new Map<string, Database>()

	return new Elysia({
		prefix: '/api/db',
		tags: ['DB Studio']
	})
		.onBeforeHandle(requireLoopback)
		.get('/databases', () => {
			return { databases: discoverDbs(dataDir) }
		})
		.get(
			'/:database/tables',
			({ params }) => {
				const db = openDb(dataDir, params.database, dbCache)
				return {
					database: params.database,
					tables: getTables(db)
				}
			},
			{ params: dbParamsSchema }
		)
		.get(
			'/:database/:table/schema',
			({ params }) => {
				const db = openDb(dataDir, params.database, dbCache)
				const schema = getSchema(db, params.table)
				return {
					database: params.database,
					table: params.table,
					...schema
				}
			},
			{ params: dbTableParamsSchema }
		)
		.get(
			'/:database/:table',
			({ params, query }) =>
				queryTableRows(dataDir, dbCache, params, query),
			{
				params: dbTableParamsSchema,
				query: rowsQuerySchema
			}
		)
}
