import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ResolvedStudioPublic {
	dir: string
	source: 'env' | 'found' | 'fallback'
}

/**
 * Resolve the directory containing the web frontend assets.
 *
 * Checks (in order):
 *  1. `ELLIE_STUDIO_PUBLIC` env var
 *  2. Each candidate path — first one that exists wins
 *  3. Last candidate as fallback (even if it doesn't exist)
 */
export function resolveStudioPublic({
	candidates,
	env = process.env,
	pathExists = existsSync
}: {
	candidates: string[]
	env?: NodeJS.ProcessEnv
	pathExists?: (path: string) => boolean
}): ResolvedStudioPublic {
	const explicitDir = env.ELLIE_STUDIO_PUBLIC
	if (explicitDir) {
		return { dir: explicitDir, source: 'env' }
	}

	for (const dir of candidates) {
		if (pathExists(dir)) {
			return { dir, source: 'found' }
		}
	}

	return {
		dir:
			candidates.at(-1) ??
			resolve(import.meta.dir, '../../../web'),
		source: 'fallback'
	}
}
