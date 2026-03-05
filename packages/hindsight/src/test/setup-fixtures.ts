/**
 * Test fixture data, constants, and credential/environment detection.
 *
 * Split from setup.ts — provides embedding fixtures, dimension constants,
 * extraction test mode flags, and LLM credential availability flags.
 */

import { join, resolve } from 'path'
import { readFileSync, existsSync } from 'fs'
import { describe } from 'bun:test'
import { loadCredentialMap } from '@ellie/ai/credentials'

// ── Load pre-generated embeddings fixture ────────────────────────────────────
//
// Real embeddings from nomic-embed-text (768 dims) generated via:
//   bun run generate-embeddings
//
// Falls back to hash-based embeddings if fixture is missing.

let EMBEDDING_FIXTURE: Record<string, number[]> = {}
try {
	const fixturePath = join(
		import.meta.dir,
		'fixtures',
		'embeddings.json'
	)
	EMBEDDING_FIXTURE = JSON.parse(
		readFileSync(fixturePath, 'utf-8')
	)
} catch {
	// Fixture not yet generated — fall back to hash-based embeddings
}

const HAS_REAL_EMBEDDINGS =
	Object.keys(EMBEDDING_FIXTURE).length > 0

/**
 * The pre-generated embedding fixture map.
 * Exported for use by setup-mocks (mockEmbed).
 */
export { EMBEDDING_FIXTURE }

// ── Constants ────────────────────────────────────────────────────────────────

export const EMBED_DIMS = HAS_REAL_EMBEDDINGS ? 768 : 16
export const EXTRACTION_TEST_MODE =
	process.env.HINDSIGHT_EXTRACTION_TEST_MODE ??
	'deterministic'
export const EXTRACTION_TEST_CANONICAL_TIMEZONE =
	'Asia/Jerusalem'

export function useRealLLMExtractionTests(): boolean {
	return EXTRACTION_TEST_MODE === 'real-llm'
}

// ── Credential detection ─────────────────────────────────────────────────────

/**
 * Find the .credentials.json file by walking up from the repo root.
 * Handles both direct checkouts and git worktrees.
 */
function findCredentialsFile(): string | null {
	let dir = resolve(import.meta.dir, '../../../..') // packages/hindsight/src/test → repo root
	while (dir !== resolve(dir, '..')) {
		const candidate = join(dir, '.credentials.json')
		if (existsSync(candidate)) return candidate
		dir = resolve(dir, '..')
	}
	return null
}

/**
 * Path to .credentials.json if found. Exported for use by setup-factories.
 */
export const CREDENTIALS_PATH = findCredentialsFile()

export const HAS_ANTHROPIC_KEY = Boolean(
	process.env.ANTHROPIC_API_KEY
)
export const HAS_CREDENTIALS = Boolean(CREDENTIALS_PATH)
export const HAS_ANTHROPIC =
	HAS_ANTHROPIC_KEY || HAS_CREDENTIALS

// Groq credential detection (matches Python conftest.py — uses openai/gpt-oss-120b via Groq)
export const HAS_GROQ_KEY = Boolean(
	process.env.GROQ_API_KEY
)
const _hasGroqCredentials = CREDENTIALS_PATH
	? await loadCredentialMap(CREDENTIALS_PATH).then(
			map =>
				map !== null &&
				typeof map.groq === 'object' &&
				map.groq !== null &&
				'type' in map.groq
		)
	: false
export const HAS_GROQ = HAS_GROQ_KEY || _hasGroqCredentials

/** The model to use for real LLM tests. Matches Python Hindsight conftest.py. */
export const REAL_LLM_MODEL = 'openai/gpt-oss-120b'

/**
 * Feature flag: set HINDSIGHT_RUN_LLM_TESTS=1 to enable real LLM tests.
 * Defaults to off so CI and local runs skip them by default.
 */
export const RUN_LLM_TESTS =
	process.env.HINDSIGHT_RUN_LLM_TESTS === '1'

/** Use instead of `describe` for test blocks that require a real LLM. */
export const describeWithLLM =
	RUN_LLM_TESTS && (HAS_GROQ || HAS_ANTHROPIC)
		? describe
		: describe.skip
