/**
 * DB Studio — read-only, multi-database SQLite explorer.
 *
 * Discovers `.db` files in DATA_DIR and exposes:
 *   GET /db/databases           — list available databases
 *   GET /db/:database/tables    — list tables/views (system/shadow hidden)
 *   GET /db/:database/:table/schema — column types, constraints, FKs
 *   GET /db/:database/:table    — paginated rows with sort/filter
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

export function createDbStudioRoutes(dataDir: string) {
	const dbCache = new Map<string, Database>()

	return new Elysia({
		prefix: '/db',
		tags: ['DB Studio']
	})
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
			({ params, query }) => {
				const db = openDb(dataDir, params.database, dbCache)
				const { table } = params
				const page = query.page ?? 1
				const pageSize = query.pageSize ?? 100

				// Verify table exists
				const exists = db
					.query(
						`SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')`
					)
					.get(table)
				if (!exists) {
					throw new Error(`Table not found: ${table}`)
				}

				// Validate sortBy column
				let sortBy = query.sortBy ?? null
				if (sortBy) {
					const schema = getSchema(db, table)
					const validCols = new Set(
						schema.columns.map(c => c.name)
					)
					if (!validCols.has(sortBy)) {
						throw new Error(
							`Invalid sort column: ${sortBy}`
						)
					}
				}

				const sortDir =
					query.sortDir === 'desc' ? 'DESC' : 'ASC'

				// Filter
				let filterClause = ''
				let filterParams: string[] = []
				const filterRaw = query.filter ?? null
				if (filterRaw) {
					const parsed = parseFilter(filterRaw)
					// Validate filter column
					const schema = getSchema(db, table)
					const validCols = new Set(
						schema.columns.map(c => c.name)
					)
					if (!validCols.has(parsed.column)) {
						throw new Error(
							`Invalid filter column: ${parsed.column}`
						)
					}
					const clause = buildFilterClause(parsed)
					filterClause = `WHERE ${clause.sql}`
					filterParams = clause.params
				}

				const pg = Number(page)
				const ps = Number(pageSize)

				// Count
				let totalRows: number
				try {
					const countRow = db
						.query(
							`SELECT COUNT(*) as cnt FROM ${quoteId(table)} ${filterClause}`
						)
						.get(...filterParams) as {
						cnt: number
					}
					totalRows = countRow.cnt
				} catch {
					// Virtual tables might fail on COUNT
					totalRows = 0
				}

				const totalPages = Math.max(
					1,
					Math.ceil(totalRows / ps)
				)

				// Rows
				const orderClause = sortBy
					? `ORDER BY ${quoteId(sortBy)} ${sortDir}`
					: ''
				const offset = (pg - 1) * ps

				let rows: Array<Record<string, unknown>>
				try {
					rows = db
						.query(
							`SELECT * FROM ${quoteId(table)} ${filterClause} ${orderClause} LIMIT ? OFFSET ?`
						)
						.all(...filterParams, ps, offset) as Array<
						Record<string, unknown>
					>
				} catch {
					// Virtual tables might fail on SELECT *
					rows = []
				}

				return {
					database: params.database,
					table,
					page,
					pageSize,
					totalRows,
					totalPages,
					sortBy,
					sortDir: query.sortDir ?? 'asc',
					filter: filterRaw,
					rows
				}
			},
			{
				params: dbTableParamsSchema,
				query: rowsQuerySchema
			}
		)
}
