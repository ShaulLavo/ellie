import { useQuery } from '@tanstack/react-query'
import {
	fetchDatabases,
	fetchTables,
	fetchSchema,
	fetchRows
} from '../api'

export function useDbDatabases() {
	return useQuery({
		queryKey: ['db-studio', 'databases'],
		queryFn: fetchDatabases,
		select: data => data.databases,
		staleTime: 30_000
	})
}

export function useDbTables(database: string | undefined) {
	return useQuery({
		queryKey: ['db-studio', 'tables', database],
		queryFn: () => fetchTables(database!),
		enabled: !!database,
		select: data => data.tables,
		staleTime: 30_000
	})
}

export function useDbSchema(
	database: string | undefined,
	table: string | undefined
) {
	return useQuery({
		queryKey: ['db-studio', 'schema', database, table],
		queryFn: () => fetchSchema(database!, table!),
		enabled: !!database && !!table,
		staleTime: 60_000
	})
}

export function useDbRows(
	database: string | undefined,
	table: string | undefined,
	opts: {
		page?: number
		pageSize?: number
		sortBy?: string
		sortDir?: 'asc' | 'desc'
		filter?: string
	} = {}
) {
	return useQuery({
		queryKey: ['db-studio', 'rows', database, table, opts],
		queryFn: () => fetchRows(database!, table!, opts),
		enabled: !!database && !!table,
		staleTime: 10_000
	})
}
