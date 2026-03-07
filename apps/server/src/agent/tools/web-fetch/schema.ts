import * as v from 'valibot'

export const webFetchParams = v.object({
	url: v.pipe(
		v.string(),
		v.description('The URL of the web page to fetch')
	)
})

export type WebFetchParams = v.InferOutput<
	typeof webFetchParams
>
