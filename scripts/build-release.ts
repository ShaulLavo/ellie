#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import {
	chmod,
	cp,
	mkdir,
	rm,
	writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DIST_DIR = join(ROOT, 'dist')
const RELEASE_DIR = join(DIST_DIR, 'release')
const BIN_DIR = join(RELEASE_DIR, 'bin')
const RESOURCE_DIR = join(RELEASE_DIR, 'resources')
const WEB_DIR = join(RELEASE_DIR, 'web')
const LIB_DIR = join(RELEASE_DIR, 'lib')
const ARCHIVE_NAME = `ellie-${process.platform}-${process.arch}.tar.gz`
const ARCHIVE_PATH = join(DIST_DIR, ARCHIVE_NAME)
const TEI_BINARY = 'text-embeddings-router'
const SQLITE_LIB_NAME = `libsqlite3-vec.${sqliteLibExt()}`
const textDecoder = new TextDecoder()

const ROOT_ENTRIES = ['turbo.json', 'README.md']

const RESOURCE_ENTRIES = [
	{
		source: 'apps/web/dist',
		target: 'web'
	},
	{
		source: 'apps/server/src/agent/templates',
		target: 'resources/agent-templates'
	},
	{
		source: 'packages/db/drizzle',
		target: 'resources/db-drizzle'
	},
	{
		source: 'packages/hindsight/drizzle',
		target: 'resources/hindsight-drizzle'
	},
	{
		source: `packages/db/vendor/${SQLITE_LIB_NAME}`,
		target: `lib/${SQLITE_LIB_NAME}`
	}
] as const

async function main() {
	await ensureRequiredCommands()
	await buildRuntimeArtifacts()
	await prepareReleaseDir()
	await bundleServer()
	await copyReleaseFiles()
	await stageNativeModules()
	await stageBinaries()
	await writeStartScript()
	await createArchive()
	printSummary()
}

async function ensureRequiredCommands() {
	const required = ['go', 'cargo', 'tar']
	for (const command of required) {
		if (findBinary(command)) continue
		throw new Error(
			`${command} is required to build the release bundle`
		)
	}
}

async function buildRuntimeArtifacts() {
	await run(
		['bun', 'run', 'build'],
		join(ROOT, 'packages/db')
	)
	await run(['bun', 'run', 'build'], join(ROOT, 'apps/web'))
	await run(['bun', 'run', 'build'], join(ROOT, 'apps/cli'))
	await run(
		[
			'go',
			'build',
			'-o',
			'bin/pty-bridge',
			'./cmd/pty-bridge'
		],
		join(ROOT, 'apps/cli')
	)
	await run(['bun', 'run', '--cwd', 'apps/stt', 'build'])
}

async function prepareReleaseDir() {
	await rm(RELEASE_DIR, { force: true, recursive: true })
	await mkdir(RELEASE_DIR, { recursive: true })
	await mkdir(BIN_DIR, { recursive: true })
	await mkdir(RESOURCE_DIR, { recursive: true })
	await mkdir(WEB_DIR, { recursive: true })
	await mkdir(LIB_DIR, { recursive: true })
	await rm(ARCHIVE_PATH, { force: true })
}

async function bundleServer() {
	await run(
		[
			'bun',
			'build',
			'apps/server/src/server.ts',
			'--target',
			'bun',
			'--external',
			'sharp',
			'--outfile',
			join(RELEASE_DIR, 'server.js')
		],
		ROOT
	)
}

async function copyReleaseFiles() {
	for (const entry of ROOT_ENTRIES) {
		await copyIntoRelease(entry, entry)
	}

	for (const entry of RESOURCE_ENTRIES) {
		await copyIntoRelease(entry.source, entry.target)
	}
}

async function stageNativeModules() {
	const nmDir = join(RELEASE_DIR, 'node_modules')
	await mkdir(nmDir, { recursive: true })

	// sharp has native bindings that can't be bundled — resolve from
	// apps/server where it's a direct dependency and copy the package
	// tree so require('sharp') works at runtime.
	const resolveProc = Bun.spawnSync(
		['bun', '-e', 'console.log(require.resolve("sharp"))'],
		{
			cwd: join(ROOT, 'apps/server'),
			stdout: 'pipe',
			stderr: 'pipe'
		}
	)
	const sharpIndex = textDecoder
		.decode(resolveProc.stdout)
		.trim()
	if (!sharpIndex) {
		throw new Error(
			'could not resolve sharp from apps/server'
		)
	}

	// sharpIndex is like .../node_modules/sharp/lib/index.js
	// walk up to the node_modules dir containing sharp
	const sharpPkg = resolve(sharpIndex, '..', '..')
	const sharpParent = dirname(sharpPkg)

	for (const entry of [
		'sharp',
		'@img',
		'detect-libc',
		'semver'
	]) {
		const src = join(sharpParent, entry)
		if (!existsSync(src)) continue
		const dst = join(nmDir, entry)
		await cp(src, dst, {
			recursive: true,
			dereference: true
		})
	}
}

async function stageBinaries() {
	await copyBinary('apps/cli/bin/ellie', 'bin/ellie')
	await copyBinary(
		'apps/cli/bin/pty-bridge',
		'bin/pty-bridge'
	)
	await copyBinary(
		'apps/stt/target/release/stt-server',
		'bin/stt-server'
	)

	const teiPath = findBinary(TEI_BINARY)
	if (!teiPath) return

	await cp(teiPath, join(BIN_DIR, TEI_BINARY))
	await chmod(join(BIN_DIR, TEI_BINARY), 0o755)
}

async function writeStartScript() {
	const content = `#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

mkdir -p "$ROOT/data/models/stt"

export PATH="$ROOT/bin:$PATH"
export NODE_ENV="\${NODE_ENV:-production}"
export DATA_DIR="\${DATA_DIR:-$ROOT/data}"
export CREDENTIALS_PATH="\${CREDENTIALS_PATH:-$ROOT/.credentials.json}"
export ELLIE_STUDIO_PUBLIC="\${ELLIE_STUDIO_PUBLIC:-$ROOT/web}"
export ELLIE_WORKSPACE_TEMPLATES_DIR="\${ELLIE_WORKSPACE_TEMPLATES_DIR:-$ROOT/resources/agent-templates}"
export ELLIE_DB_MIGRATIONS_DIR="\${ELLIE_DB_MIGRATIONS_DIR:-$ROOT/resources/db-drizzle}"
export ELLIE_HINDSIGHT_MIGRATIONS_DIR="\${ELLIE_HINDSIGHT_MIGRATIONS_DIR:-$ROOT/resources/hindsight-drizzle}"
export ELLIE_SQLITE_LIB_PATH="\${ELLIE_SQLITE_LIB_PATH:-$ROOT/lib/${SQLITE_LIB_NAME}}"
export ELLIE_PTY_BRIDGE_PATH="\${ELLIE_PTY_BRIDGE_PATH:-$ROOT/bin/pty-bridge}"
export ELLIE_CLI_PATH="\${ELLIE_CLI_PATH:-$ROOT/bin/ellie}"
export ELLIE_STT_MODELS_DIR="\${ELLIE_STT_MODELS_DIR:-$ROOT/data/models/stt}"
export NODE_PATH="\${NODE_PATH:-$ROOT/node_modules}"

exec bun "$ROOT/server.js" "$@"
`

	const startPath = join(RELEASE_DIR, 'start.sh')
	await writeFile(startPath, content)
	await chmod(startPath, 0o755)
}

async function createArchive() {
	await run(
		[
			'tar',
			'-czf',
			ARCHIVE_PATH,
			'-C',
			DIST_DIR,
			'release'
		],
		ROOT
	)
}

function printSummary() {
	console.log('')
	console.log(`release dir: ${RELEASE_DIR}`)
	console.log(`archive: ${ARCHIVE_PATH}`)
	console.log('')
	console.log('run locally from the bundle with:')
	console.log(`  cd ${RELEASE_DIR}`)
	console.log('  ./start.sh')
	console.log('  ./bin/ellie start')
}

async function copyIntoRelease(
	sourcePath: string,
	targetPath: string
) {
	const source = join(ROOT, sourcePath)
	const target = join(RELEASE_DIR, targetPath)
	await mkdir(dirname(target), { recursive: true })
	await cp(source, target, { recursive: true })
}

async function copyBinary(
	sourcePath: string,
	targetPath: string
) {
	const source = join(ROOT, sourcePath)
	if (!existsSync(source)) {
		throw new Error(`missing binary: ${sourcePath}`)
	}

	const target = join(RELEASE_DIR, targetPath)
	await mkdir(dirname(target), { recursive: true })
	await cp(source, target)
	await chmod(target, 0o755)
}

function findBinary(name: string): string | null {
	const proc = Bun.spawnSync(['which', name], {
		cwd: ROOT,
		stdout: 'pipe',
		stderr: 'ignore'
	})

	if (proc.exitCode !== 0) return null
	return textDecoder.decode(proc.stdout).trim() || null
}

async function run(args: string[], cwd: string = ROOT) {
	console.log(`$ ${args.join(' ')}`)
	const proc = Bun.spawn(args, {
		cwd,
		stdout: 'inherit',
		stderr: 'inherit',
		env: process.env
	})
	const exitCode = await proc.exited
	if (exitCode === 0) return
	throw new Error(
		`command failed (${exitCode}): ${args.join(' ')}`
	)
}

function sqliteLibExt() {
	if (process.platform === 'darwin') return 'dylib'
	return 'so'
}

await main()
