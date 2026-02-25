/**
 * Phase 2 Verification — Dataset Generation
 *
 * Generates deterministic datasets for the Phase 2 verification harness:
 *
 * rolling_ingest.v1: at least 800 ingest events with labeled
 *   cluster_id, entity, attribute, value, scope fields, and timestamps.
 *
 * temporal_narrative.v1: at least 200 questions with expected ordered
 *   memory IDs.
 *
 * Datasets are deterministic (seeded) to ensure reproducibility.
 */

import type {
	RollingIngestEvent,
	TemporalNarrativeQuestion
} from './phase2-types'

// ── Deterministic PRNG ──────────────────────────────────────────────────

/**
 * Simple seeded PRNG (Mulberry32) for deterministic dataset generation.
 */
function mulberry32(seed: number): () => number {
	let state = seed | 0
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// ── Rolling Ingest Dataset ──────────────────────────────────────────────

const ENTITIES = [
	'Alice',
	'Bob',
	'Charlie',
	'Diana',
	'Eve',
	'Acme Corp',
	'TechStart',
	'GlobalInc',
	'FoodCo',
	'BuildIt',
	'New York',
	'San Francisco',
	'London',
	'Tokyo',
	'Berlin',
	'Project Alpha',
	'Project Beta',
	'Project Gamma',
	'Project Delta',
	'Project Epsilon'
]

const ATTRIBUTES = [
	'role',
	'department',
	'location',
	'status',
	'preference',
	'category',
	'priority',
	'type',
	'stage',
	'sentiment'
]

const VALUES: Record<string, string[]> = {
	role: [
		'engineer',
		'manager',
		'designer',
		'analyst',
		'director'
	],
	department: [
		'engineering',
		'marketing',
		'sales',
		'hr',
		'finance'
	],
	location: [
		'remote',
		'office',
		'hybrid',
		'traveling',
		'relocating'
	],
	status: [
		'active',
		'inactive',
		'pending',
		'completed',
		'archived'
	],
	preference: ['high', 'medium', 'low', 'critical', 'none'],
	category: [
		'technical',
		'business',
		'personal',
		'research',
		'support'
	],
	priority: ['P0', 'P1', 'P2', 'P3', 'P4'],
	type: [
		'task',
		'bug',
		'feature',
		'improvement',
		'documentation'
	],
	stage: [
		'planning',
		'development',
		'testing',
		'review',
		'deployment'
	],
	sentiment: [
		'positive',
		'neutral',
		'negative',
		'mixed',
		'unknown'
	]
}

const SCOPES = [
	'work',
	'personal',
	'research',
	'meetings',
	'admin'
]

const FACT_TYPES: Array<
	'world' | 'experience' | 'opinion' | 'observation'
> = ['world', 'experience', 'opinion', 'observation']

/**
 * Generate a rolling ingest dataset with labeled clusters, entities,
 * attributes, values, and scope fields.
 *
 * @param count - Number of events to generate (minimum 800)
 * @param seed - PRNG seed for reproducibility
 */
export function generateRollingIngestDataset(
	count: number = 800,
	seed: number = 42
): RollingIngestEvent[] {
	const random = mulberry32(seed)
	const events: RollingIngestEvent[] = []
	const baseTimestamp = new Date(
		'2025-01-01T00:00:00Z'
	).getTime()

	// Generate clusters: each cluster has a unique entity+attribute combination.
	// Some clusters will have multiple events (duplicates) to test dedup.
	const numClusters = Math.ceil(count * 0.6) // ~60% unique clusters
	const clusterDefs: Array<{
		clusterId: string
		entity: string
		attribute: string
		baseValue: string
		scope: string
	}> = []

	for (let i = 0; i < numClusters; i++) {
		const entity =
			ENTITIES[Math.floor(random() * ENTITIES.length)]!
		const attribute =
			ATTRIBUTES[Math.floor(random() * ATTRIBUTES.length)]!
		const valueOptions = VALUES[attribute]!
		const baseValue =
			valueOptions[
				Math.floor(random() * valueOptions.length)
			]!
		const scope =
			SCOPES[Math.floor(random() * SCOPES.length)]!

		clusterDefs.push({
			clusterId: `cluster-${i.toString().padStart(4, '0')}`,
			entity,
			attribute,
			baseValue,
			scope
		})
	}

	let eventIndex = 0
	let timestampOffset = 0

	// First pass: create one event per cluster
	for (const cluster of clusterDefs) {
		if (eventIndex >= count) break

		// Vary time gaps: some within 45 min, some beyond
		const gapMinutes =
			random() < 0.7
				? Math.floor(random() * 40) + 1 // Within 45 min (70% of events)
				: Math.floor(random() * 120) + 46 // Beyond 45 min (30% of events)

		timestampOffset += gapMinutes * 60 * 1000

		events.push({
			eventId: `ev-${eventIndex.toString().padStart(5, '0')}`,
			clusterId: cluster.clusterId,
			content: `${cluster.entity} has ${cluster.attribute} set to ${cluster.baseValue}`,
			entity: cluster.entity,
			attribute: cluster.attribute,
			value: cluster.baseValue,
			scope: cluster.scope,
			timestamp: baseTimestamp + timestampOffset,
			factType:
				FACT_TYPES[
					Math.floor(random() * FACT_TYPES.length)
				]!,
			tags: [cluster.scope]
		})

		eventIndex++
	}

	// Second pass: create duplicate/update events for some clusters
	while (eventIndex < count) {
		const clusterIdx = Math.floor(
			random() * clusterDefs.length
		)
		const cluster = clusterDefs[clusterIdx]!

		timestampOffset +=
			Math.floor(random() * 30 + 1) * 60 * 1000

		// 50% chance of same value (duplicate), 50% chance of changed value (conflict)
		const isConflict = random() > 0.5
		const valueOptions = VALUES[cluster.attribute]!
		const value = isConflict
			? (valueOptions.filter(v => v !== cluster.baseValue)[
					Math.floor(random() * (valueOptions.length - 1))
				] ?? cluster.baseValue)
			: cluster.baseValue

		events.push({
			eventId: `ev-${eventIndex.toString().padStart(5, '0')}`,
			clusterId: cluster.clusterId,
			content: `${cluster.entity} has ${cluster.attribute} set to ${value}`,
			entity: cluster.entity,
			attribute: cluster.attribute,
			value,
			scope: cluster.scope,
			timestamp: baseTimestamp + timestampOffset,
			factType:
				FACT_TYPES[
					Math.floor(random() * FACT_TYPES.length)
				]!,
			tags: [cluster.scope]
		})

		eventIndex++
	}

	// Sort by timestamp for temporal ordering
	events.sort((a, b) => a.timestamp - b.timestamp)

	return events
}

// ── Temporal Narrative QA Dataset ────────────────────────────────────────

/**
 * Generate temporal narrative QA questions.
 *
 * Each question provides an anchor memory and a set of expected
 * ordered memory IDs that should appear in the narrative output.
 *
 * @param count - Number of questions to generate (minimum 200)
 * @param totalEvents - Total event count for valid ID range
 * @param seed - PRNG seed for reproducibility
 */
export function generateTemporalNarrativeDataset(
	count: number = 200,
	totalEvents: number = 800,
	seed: number = 42
): TemporalNarrativeQuestion[] {
	const random = mulberry32(seed)
	const questions: TemporalNarrativeQuestion[] = []

	for (let i = 0; i < count; i++) {
		// Pick an anchor event somewhere in the middle
		const anchorIdx =
			Math.floor(random() * (totalEvents - 10)) + 5

		// Pick 2-5 expected events around the anchor
		const numExpected = Math.floor(random() * 4) + 2
		const expectedIndices: number[] = []

		const dirRoll = random()
		const direction: 'before' | 'after' | 'both' =
			dirRoll < 0.33
				? 'before'
				: dirRoll < 0.66
					? 'after'
					: 'both'

		for (let j = 0; j < numExpected; j++) {
			let idx: number
			if (direction === 'before') {
				idx = anchorIdx - Math.floor(random() * 5) - 1
			} else if (direction === 'after') {
				idx = anchorIdx + Math.floor(random() * 5) + 1
			} else {
				idx =
					random() < 0.5
						? anchorIdx - Math.floor(random() * 3) - 1
						: anchorIdx + Math.floor(random() * 3) + 1
			}

			idx = Math.max(0, Math.min(totalEvents - 1, idx))

			if (
				!expectedIndices.includes(idx) &&
				idx !== anchorIdx
			) {
				expectedIndices.push(idx)
			}
		}

		// Sort expected indices for correct temporal ordering
		expectedIndices.sort((a, b) => a - b)

		questions.push({
			questionId: `q-${i.toString().padStart(4, '0')}`,
			question: `What events occurred ${direction === 'before' ? 'before' : direction === 'after' ? 'after' : 'around'} event ${anchorIdx}?`,
			anchorMemoryId: `mem-${anchorIdx.toString().padStart(5, '0')}`,
			expectedOrderedMemoryIds: expectedIndices.map(
				idx => `mem-${idx.toString().padStart(5, '0')}`
			),
			direction
		})
	}

	return questions
}

// ── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize a dataset to JSONL format.
 */
/** Convert an array of items to newline-delimited JSON (JSONL) format. */
export function toJsonl<T>(items: T[]): string {
	return (
		items.map(item => JSON.stringify(item)).join('\n') +
		'\n'
	)
}
