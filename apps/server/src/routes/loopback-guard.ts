import { ForbiddenError } from './http-errors'

const LOOPBACK_ADDRS = new Set([
	'127.0.0.1',
	'::1',
	'::ffff:127.0.0.1'
])

/** Elysia onBeforeHandle guard that restricts to localhost requests. */
export function requireLoopback({
	request,
	server
}: {
	request: Request
	server?: {
		requestIP(r: Request): { address: string } | null
	} | null
}) {
	// In test environments (app.handle()), server is null — allow through
	if (!server) return

	const ip = server.requestIP(request)
	const addr = ip?.address
	if (!addr || !LOOPBACK_ADDRS.has(addr)) {
		throw new ForbiddenError(
			'This route is only available from localhost'
		)
	}
}
