/**
 * URL parsing and generation helpers for the tus protocol.
 * Extracted from server.ts for locality.
 */

const reExtractFileID = /([^/]+)\/?$/
const reForwardedHost = /host="?([^";]+)/
const reForwardedProto = /proto=(https?)/

export function extractHostAndProto(
	headers: Headers,
	respect?: boolean
): { host: string; proto: string } {
	let proto: string | undefined
	let host: string | undefined

	if (respect) {
		const forwarded = headers.get('forwarded')
		if (forwarded) {
			host ??= reForwardedHost.exec(forwarded)?.[1]
			proto ??= reForwardedProto.exec(forwarded)?.[1]
		}

		const forwardHost = headers.get('x-forwarded-host')
		const forwardProto = headers.get('x-forwarded-proto')

		if (
			forwardProto === 'http' ||
			forwardProto === 'https'
		) {
			proto ??= forwardProto
		}
		host ??= forwardHost ?? undefined
	}

	host ??= headers.get('host') ?? 'localhost'
	proto ??= 'http'

	return { host, proto }
}

export function extractFileId(
	url: string,
	pathPrefix: string
): string | undefined {
	const parsed = new URL(url)
	const pathAfterPrefix = parsed.pathname
		.replace(pathPrefix, '')
		.replace(/^\//, '')
	if (!pathAfterPrefix) return undefined
	const match = reExtractFileID.exec(pathAfterPrefix)
	return match ? decodeURIComponent(match[1]) : undefined
}

export function generateUploadUrl(
	req: Request,
	id: string,
	opts: {
		path: string
		relativeLocation: boolean
		respectForwardedHeaders: boolean
	}
): string {
	const path = opts.path === '/' ? '' : opts.path

	if (opts.relativeLocation) {
		return `${path}/${id}`
	}

	const { proto, host } = extractHostAndProto(
		req.headers,
		opts.respectForwardedHeaders
	)
	return `${proto}://${host}${path}/${id}`
}
