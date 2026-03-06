/**
 * Dev-only routes — destructive operations for local development.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia } from 'elysia'
import { rmSync } from 'node:fs'

/**
 * POST /api/dev/reset
 *
 * Nukes the entire DATA_DIR (events.db, hindsight.db, uploads.db,
 * uploads/, traces/, workspace/) and exits the process.
 */
export function createDevRoutes(dataDir: string) {
	return new Elysia({
		prefix: '/api/dev',
		tags: ['Dev']
	}).post('/reset', () => {
		console.warn('[dev] Nuking data directory:', dataDir)

		try {
			rmSync(dataDir, { recursive: true, force: true })
		} catch (err) {
			console.error('[dev] Failed to delete data dir:', err)
		}

		console.warn(
			'[dev] Data wiped. Exiting — restart the server.'
		)

		// Exit after response is sent
		setTimeout(() => process.exit(0), 100)

		return {
			ok: true,
			message: 'Data wiped. Restart the server.'
		}
	})
}
