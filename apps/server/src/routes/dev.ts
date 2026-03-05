/** Dev-only routes — destructive operations for local development. */

import { Elysia } from 'elysia'
import { rmSync } from 'node:fs'

/**
 * POST /api/dev/reset
 *
 * Nukes everything: DB, JSONL logs, workspace, uploads.
 * Exits the process so you restart fresh.
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
