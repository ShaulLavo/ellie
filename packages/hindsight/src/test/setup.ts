/**
 * Shared test utilities for @ellie/hindsight tests.
 *
 * Equivalent of conftest.py from the original Hindsight project.
 * Provides a factory for creating test Hindsight instances with temp DBs
 * and pre-generated real embeddings (nomic-embed-text).
 */

import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { rmSync, readFileSync, existsSync } from 'fs'
import { describe } from 'bun:test'
import { anthropicText } from '@tanstack/ai-anthropic'
import { groqChat } from '@ellie/ai/openai-compat'
import { loadCredentialMap } from '@ellie/ai/credentials'
import { Hindsight } from '../hindsight'
import type { HindsightConfig } from '../types'
import type { HindsightDatabase } from '../db'
import {
	createMockAdapter,
	type MockAdapter
} from './mock-adapter'

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

// ── Embedding function ───────────────────────────────────────────────────────

/**
 * Hash-based fallback embedding (NOT semantically meaningful).
 * Used when a text is not found in the pre-generated fixture.
 */
function hashEmbed(text: string, dims: number): number[] {
	const vec = Array.from<number>({ length: dims }).fill(0)
	for (let i = 0; i < text.length; i++) {
		vec[i % dims] += text.charCodeAt(i) / 1000
	}
	const norm = Math.sqrt(
		vec.reduce((s: number, v: number) => s + v * v, 0)
	)
	return norm > 0 ? vec.map((v: number) => v / norm) : vec
}

/**
 * Embedding function backed by pre-generated real embeddings.
 *
 * With the fixture loaded (default):
 * - Returns real nomic-embed-text vectors for known strings
 * - Cosine similarity between "Peter" and "Peter works at Acme Corp" is high
 * - Semantic search and graph seed resolution work correctly
 *
 * Without fixture or for unknown strings:
 * - Falls back to deterministic hash-based embeddings
 * - Same text → same vector, but similarity is not semantically meaningful
 */
export function mockEmbed(text: string): Promise<number[]> {
	const precomputed = EMBEDDING_FIXTURE[text]
	if (precomputed) {
		return Promise.resolve(precomputed)
	}
	return Promise.resolve(hashEmbed(text, EMBED_DIMS))
}

// ── Test Hindsight factory ──────────────────────────────────────────────────

export interface TestHindsight {
	hs: Hindsight
	adapter: MockAdapter
	dbPath: string
	cleanup: () => void
}

export interface RealLLMTestHindsight {
	hs: Hindsight
	dbPath: string
	cleanup: () => void
}

/**
 * Create a Hindsight instance backed by a temporary SQLite database.
 *
 * Returns the instance, the mock adapter (for inspecting/configuring LLM
 * responses), and a cleanup function that closes the DB and removes the file.
 */
export function createTestHindsight(
	overrides?: Partial<HindsightConfig>
): TestHindsight {
	const dbPath = join(
		tmpdir(),
		`hindsight-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	)
	const adapter = createMockAdapter()

	const hs = new Hindsight({
		dbPath,
		embed: mockEmbed,
		embeddingDimensions: EMBED_DIMS,
		adapter:
			adapter as unknown as HindsightConfig['adapter'],
		...overrides
	})

	const cleanup = () => {
		try {
			hs.close()
		} catch {
			// already closed
		}
		try {
			rmSync(dbPath, { force: true })
			rmSync(dbPath + '-wal', { force: true })
			rmSync(dbPath + '-shm', { force: true })
		} catch {
			// file may not exist
		}
	}

	return { hs, adapter, dbPath, cleanup }
}

// ── Real LLM test factory ───────────────────────────────────────────────────

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

const CREDENTIALS_PATH = findCredentialsFile()
export const HAS_ANTHROPIC_KEY =
	!!process.env.ANTHROPIC_API_KEY
export const HAS_CREDENTIALS = !!CREDENTIALS_PATH
export const HAS_ANTHROPIC =
	HAS_ANTHROPIC_KEY || HAS_CREDENTIALS

// Groq credential detection (matches Python conftest.py — uses openai/gpt-oss-120b via Groq)
export const HAS_GROQ_KEY = !!process.env.GROQ_API_KEY
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
const REAL_LLM_MODEL = 'openai/gpt-oss-120b'

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

export interface RealTestHindsight {
	hs: Hindsight
	dbPath: string
	cleanup: () => void
}

/**
 * Resolve an LLM adapter for real tests.
 *
 * Priority: Groq (openai/gpt-oss-120b — matches Python conftest) > Anthropic.
 */
async function resolveRealAdapter(): Promise<
	HindsightConfig['adapter']
> {
	// Priority 1: Groq via env var
	if (process.env.GROQ_API_KEY) {
		return groqChat(
			REAL_LLM_MODEL,
			process.env.GROQ_API_KEY
		)
	}

	// Priority 2: Groq via credentials file
	if (CREDENTIALS_PATH) {
		const map = await loadCredentialMap(CREDENTIALS_PATH)
		const groq = map?.groq
		if (
			groq &&
			typeof groq === 'object' &&
			'type' in groq &&
			(groq as { type: string }).type === 'api_key' &&
			'key' in groq
		) {
			return groqChat(
				REAL_LLM_MODEL,
				(groq as { key: string }).key
			)
		}
	}

	// Priority 3: Anthropic via env var
	if (HAS_ANTHROPIC_KEY) {
		return anthropicText('claude-haiku-4-5')
	}

	throw new Error(
		'No LLM credentials available (need GROQ_API_KEY, ANTHROPIC_API_KEY, or .credentials.json)'
	)
}

/**
 * Create a Hindsight instance with a real LLM adapter.
 *
 * Uses Groq (openai/gpt-oss-120b) when available, matching the Python
 * Hindsight test setup. Falls back to Anthropic (claude-haiku-4-5).
 */
export async function createRealTestHindsight(
	overrides?: Partial<HindsightConfig>
): Promise<RealTestHindsight> {
	const dbPath = join(
		tmpdir(),
		`hindsight-test-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	)

	const adapter = await resolveRealAdapter()

	const hs = new Hindsight({
		dbPath,
		embed: mockEmbed,
		embeddingDimensions: EMBED_DIMS,
		adapter,
		...overrides
	})

	const cleanup = () => {
		try {
			hs.close()
		} catch {
			// already closed
		}
		try {
			rmSync(dbPath, { force: true })
			rmSync(dbPath + '-wal', { force: true })
			rmSync(dbPath + '-shm', { force: true })
		} catch {
			// file may not exist
		}
	}

	return { hs, dbPath, cleanup }
}

/**
 * Access the internal HindsightDatabase from a Hindsight instance.
 * For test use only — reaches into private state via Reflect.
 */
export function getHdb(hs: Hindsight): HindsightDatabase {
	return Reflect.get(
		hs as object,
		'hdb'
	) as HindsightDatabase
}

/**
 * Create a bank in the test Hindsight instance and return its ID.
 */
export function createTestBank(
	hs: Hindsight,
	name?: string,
	description?: string
): string {
	const bank = hs.createBank(
		name ??
			`test-bank-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		description ? { description } : undefined
	)
	return bank.id
}
