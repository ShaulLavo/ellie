/**
 * Factory/creation functions for test data.
 *
 * Split from setup.ts — provides factory functions to create Hindsight
 * test instances (mock and real LLM), plus helpers like getHdb and createTestBank.
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync } from 'fs'
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
import {
	EMBED_DIMS,
	CREDENTIALS_PATH,
	HAS_ANTHROPIC_KEY,
	REAL_LLM_MODEL
} from './setup-fixtures'
import { mockEmbed } from './setup-mocks'

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
