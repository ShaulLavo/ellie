#!/usr/bin/env bun

import { cp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const ROOT = import.meta.dir
const PUBLIC_DIR = join(ROOT, 'public')
const DIST_DIR = join(ROOT, 'dist')

// Static assets that Bun's bundler won't pick up automatically
// (not referenced from HTML/JS/CSS imports)
const STATIC_ASSETS = ['ghostty-vt.wasm', 'manifest.json']

await rm(DIST_DIR, { force: true, recursive: true })
await mkdir(DIST_DIR, { recursive: true })

const result = await Bun.build({
	entrypoints: [join(ROOT, 'index.html')],
	outdir: DIST_DIR,
	target: 'browser',
	minify: true,
	define: {
		'process.env.NODE_ENV': '"production"'
	}
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}

for (const asset of STATIC_ASSETS) {
	const src = join(PUBLIC_DIR, asset)
	if (!existsSync(src)) continue
	await cp(src, join(DIST_DIR, asset))
}

console.log(
	`web: built ${result.outputs.length} files to dist/`
)
