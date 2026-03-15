/**
 * Dev-only routes — destructive operations for local development.
 *
 * Security: This application runs exclusively on localhost. No authentication
 * is required — all routes are accessible only from the local machine.
 */

import { Elysia } from 'elysia'
import { rmSync } from 'node:fs'
import { requireLoopback } from './loopback-guard'

export function createDevRoutes(dataDir: string) {
	return new Elysia({
		prefix: '/api/dev',
		tags: ['Dev']
	})
		.onBeforeHandle(requireLoopback)
		.post('/reset', () => {
			if (process.env.NODE_ENV === 'production') {
				return {
					ok: false,
					message: 'Not available in production.'
				}
			}

			console.warn('[dev] Nuking data directory:', dataDir)

			try {
				rmSync(dataDir, {
					recursive: true,
					force: true
				})
			} catch (err) {
				console.error(
					'[dev] Failed to delete data dir:',
					err
				)
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
