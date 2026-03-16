import * as v from 'valibot'

const MAX_SEARCH_COUNT = 10

export const webSearchParams = v.object({
	query: v.pipe(
		v.string(),
		v.description('Search query string.')
	),
	count: v.optional(
		v.pipe(
			v.number(),
			v.minValue(1),
			v.maxValue(MAX_SEARCH_COUNT),
			v.description('Number of results to return (1-10).')
		)
	),
	country: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'."
			)
		)
	),
	search_lang: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"ISO language code for search results (e.g., 'de', 'en', 'fr')."
			)
		)
	),
	ui_lang: v.optional(
		v.pipe(
			v.string(),
			v.description('ISO language code for UI elements.')
		)
	),
	freshness: v.optional(
		v.pipe(
			v.string(),
			v.description(
				"Filter results by discovery time. Supports 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), and date range 'YYYY-MM-DDtoYYYY-MM-DD'."
			)
		)
	)
})

export type WebSearchParams = v.InferOutput<
	typeof webSearchParams
>
