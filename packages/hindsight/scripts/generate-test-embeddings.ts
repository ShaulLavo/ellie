#!/usr/bin/env bun

/**
 * Generate real embeddings for the test fixture using Ollama.
 *
 * Prerequisites:
 *   ollama pull nomic-embed-text
 *
 * Usage:
 *   bun run scripts/generate-test-embeddings.ts
 *   # or: bun run generate-embeddings
 *
 * Output:
 *   src/test/fixtures/embeddings.json
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MODEL = 'nomic-embed-text'
const BASE_URL = 'http://localhost:11434'
const BATCH_SIZE = 50

// ── All unique texts that flow through the embedding pipeline in tests ──────
//
// Organized by category. Duplicates are removed after merging.
// Keep this list in sync with the test files.

const CONTENT_STRINGS = [
	// recall.test.ts
	'Peter loves hiking in the mountains',
	'Alice enjoys reading science fiction',
	'TypeScript is a typed superset of JavaScript',
	'Peter thinks Python is a great language',
	'Bob built a treehouse',
	'Recent event',
	// recall-methods.test.ts
	'Peter enjoys mountain hiking',
	'The stock market crashed today',
	'Python is a versatile programming language',
	'The weather is nice today',
	'Peter was running through the park',
	'Peter works at Acme Corp',
	'Peter loves hiking',
	'Heavy rain started in the afternoon',
	'The hiking trail became muddy',
	'Alice writes Python services',
	'Bob writes Python pipelines',
	'Carol writes Python scripts',
	'Alice enjoys reading',
	'Meeting happened this morning',
	'Conference was last month',
	'Old event',
	'Alice works with Python at TechCorp',
	'Bob uses Python at DataSoft',
	'Peter enjoys mountain hiking trails',
	'Alice likes reading books',
	// recall-tags.test.ts
	'Project Alpha update: shipped v2.0',
	'Project Beta kickoff meeting',
	'General company announcement',
	"User A's private note",
	"User B's private note",
	// retain.test.ts
	'Alice likes reading',
	'Fact 1',
	'Banked fact',
	'No type specified',
	'Fact A',
	'Fact B',
	'Fact C',
	'Peter went to the store',
	'Tagged fact',
	'Fact with tags',
	'Peter loves hiking in the Alps',
	'It started raining heavily',
	'The hiking trail became muddy and slippery',
	'Event happened yesterday',
	'Timeless fact',
	'Metadata fact',
	// dedup.test.ts
	'xyz 123 !@#',
	// observations.test.ts
	'Peter works at Acme Corp in New York',
	'Peter went hiking',
	'Peter likes cooking',
	'Google announced a new AI model',
	'Alice met Bob at the conference',
	// consolidation.test.ts
	'It is sunny right now.',
	'Alice likes sushi.',
	'Alice likes Japanese food.',
	'Alice likes sushi and Japanese food.',
	'Alice often chooses sushi restaurants.',
	// consolidation adapter responses
	'Alice works with Python APIs',
	'Bob builds Python data pipelines',
	// causal-relations.test.ts
	// mock-adapter.ts default
	'Mock fact extracted from text'
]

const QUERY_STRINGS = [
	'hiking',
	'programming languages',
	'test',
	'xyznonexistent123',
	'what happened yesterday?',
	'outdoor activities',
	'Python programming',
	'run',
	'Peter',
	'Peter hiking',
	'Bob',
	'meeting',
	'event',
	'project update',
	'project',
	'private note',
	'building',
	'Alice Bob conference',
	'What does Peter like?'
]

const ENTITY_NAMES = [
	'Alice',
	'Acme Corp',
	'Bob',
	'Carol',
	'DataSoft',
	'Google',
	'New York',
	'Peter',
	'Python',
	'TechCorp'
]

const MENTAL_MODEL_QUERIES = [
	"What are the team's communication preferences?",
	'Team summary',
	'query',
	'q',
	'q1',
	'q2',
	'q3'
]

// ── Deduplicate ─────────────────────────────────────────────────────────────

const ALL_TEXTS = [...CONTENT_STRINGS, ...QUERY_STRINGS, ...ENTITY_NAMES, ...MENTAL_MODEL_QUERIES]

const uniqueTexts = [...new Set(ALL_TEXTS)].sort()

// ── Ollama API ──────────────────────────────────────────────────────────────

interface OllamaEmbedResponse {
	model: string
	embeddings: number[][]
}

async function embedBatch(texts: string[]): Promise<number[][]> {
	const response = await fetch(`${BASE_URL}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: MODEL, input: texts })
	})

	if (!response.ok) {
		const body = await response.text()
		throw new Error(`Ollama embed failed (${response.status}): ${body}`)
	}

	const data = (await response.json()) as OllamaEmbedResponse
	if (data.embeddings.length !== texts.length) {
		throw new Error(
			`Embedding count mismatch: expected ${texts.length}, got ${data.embeddings.length}`
		)
	}
	return data.embeddings
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.log(`Generating embeddings for ${uniqueTexts.length} unique texts...`)
	console.log(`Model: ${MODEL}`)
	console.log(`Endpoint: ${BASE_URL}/api/embed`)
	console.log()

	const embeddings: Record<string, number[]> = {}

	for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
		const batch = uniqueTexts.slice(i, i + BATCH_SIZE)
		const batchNum = Math.floor(i / BATCH_SIZE) + 1
		const totalBatches = Math.ceil(uniqueTexts.length / BATCH_SIZE)
		console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.length} texts...`)

		const vectors = await embedBatch(batch)
		for (let j = 0; j < batch.length; j++) {
			embeddings[batch[j]!] = vectors[j]!
		}
	}

	const dims = Object.values(embeddings)[0]?.length
	console.log()
	console.log(`Embedding dimensions: ${dims}`)
	console.log(`Total embeddings: ${Object.keys(embeddings).length}`)

	// Write fixture (sorted keys for stable diffs)
	const fixtureDir = join(__dirname, '..', 'src', 'test', 'fixtures')
	mkdirSync(fixtureDir, { recursive: true })

	const sorted: Record<string, number[]> = {}
	for (const key of Object.keys(embeddings).sort()) {
		sorted[key] = embeddings[key]!
	}

	const fixturePath = join(fixtureDir, 'embeddings.json')
	writeFileSync(fixturePath, JSON.stringify(sorted, null, 2) + '\n')
	console.log(`Written to: ${fixturePath}`)
}

main().catch(err => {
	console.error('Failed:', err)
	process.exit(1)
})
