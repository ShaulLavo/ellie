export type DatabaseInfo = {
	name: string
	sizeBytes: number
	updatedAt: string
}

export type TableInfo = {
	name: string
	type: 'table' | 'view'
	isVirtual: boolean
}

export type ColumnInfo = {
	name: string
	type: string
	notNull: boolean
	primaryKey: boolean
	defaultValue: string | null
	unique: boolean
	hidden: boolean
}

export type ForeignKeyInfo = {
	from: string
	to: string
	targetTable: string
	onUpdate: string
	onDelete: string
}

export type SchemaResponse = {
	database: string
	table: string
	columns: ColumnInfo[]
	foreignKeys: ForeignKeyInfo[]
}

export type RowsResponse = {
	database: string
	table: string
	page: number
	pageSize: number
	totalRows: number
	totalPages: number
	sortBy: string | null
	sortDir: 'asc' | 'desc'
	filter: string | null
	rows: Record<string, unknown>[]
}
