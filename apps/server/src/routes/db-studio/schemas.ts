import * as v from 'valibot'

export const dbParamsSchema = v.object({
	database: v.pipe(v.string(), v.nonEmpty())
})

export const dbTableParamsSchema = v.object({
	database: v.pipe(v.string(), v.nonEmpty()),
	table: v.pipe(v.string(), v.nonEmpty())
})

export const rowsQuerySchema = v.object({
	page: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.number(),
			v.integer(),
			v.minValue(1)
		),
		'1'
	),
	pageSize: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(1000)
		),
		'100'
	),
	sortBy: v.optional(v.string()),
	sortDir: v.optional(v.picklist(['asc', 'desc'])),
	filter: v.optional(v.string())
})
