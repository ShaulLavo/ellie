import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type StudioPublicSource =
	| 'env'
	| 'bundle'
	| 'dev'
	| 'dev-fallback'

export interface ResolveStudioPublicOptions {
	bundledDir?: string
	devDir?: string
	env?: NodeJS.ProcessEnv
	pathExists?: (path: string) => boolean
}

export interface ResolvedStudioPublic {
	dir: string
	publicDir: string | null
	source: StudioPublicSource
}

const DEFAULT_BUNDLED_DIR = resolve(
	import.meta.dir,
	'../../../web/dist'
)
const DEFAULT_DEV_DIR = resolve(
	import.meta.dir,
	'../../../web/public'
)

export function resolveStudioPublic({
	bundledDir = DEFAULT_BUNDLED_DIR,
	devDir = DEFAULT_DEV_DIR,
	env = process.env,
	pathExists = existsSync
}: ResolveStudioPublicOptions = {}): ResolvedStudioPublic {
	const explicitDir = env.ELLIE_STUDIO_PUBLIC
	if (explicitDir) {
		return {
			dir: explicitDir,
			publicDir: null,
			source: 'env'
		}
	}

	if (env.NODE_ENV === 'production') {
		if (pathExists(bundledDir)) {
			return {
				dir: bundledDir,
				publicDir: null,
				source: 'bundle'
			}
		}

		return {
			dir: devDir,
			publicDir: null,
			source: 'dev-fallback'
		}
	}

	return {
		dir: devDir,
		publicDir: null,
		source: 'dev'
	}
}
