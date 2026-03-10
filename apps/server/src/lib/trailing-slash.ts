export function normalizeTrailingSlashPath(
	pathname: string
): string {
	if (pathname === '/') return pathname

	return pathname.replace(/\/+$/, '') || '/'
}

export function getTrailingSlashRedirectUrl(
	requestUrl: string
): string | null {
	const url = new URL(requestUrl)
	const pathname = normalizeTrailingSlashPath(url.pathname)
	if (pathname === url.pathname) return null

	url.pathname = pathname
	return url.toString()
}
