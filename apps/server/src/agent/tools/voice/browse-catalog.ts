/**
 * browse_voice_catalog — search ElevenLabs voice catalog.
 *
 * Lazy-loads API key from .credentials.json.
 * Caches catalog results in memory (15min TTL).
 */

import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import { loadElevenLabsCredential } from '@ellie/ai/credentials'
import * as v from 'valibot'

// ── Constants ────────────────────────────────────────────────────────────

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io'
const CACHE_TTL_MS = 15 * 60_000
const DEFAULT_TIMEOUT_MS = 15_000

// ── Schema ───────────────────────────────────────────────────────────────

const browseVoiceCatalogParams = v.object({
	query: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Search query to filter voices by name, description, or labels'
			)
		)
	),
	category: v.optional(
		v.pipe(
			v.picklist([
				'premade',
				'cloned',
				'generated',
				'professional'
			]),
			v.description('Filter voices by category')
		)
	),
	limit: v.optional(
		v.pipe(
			v.number(),
			v.minValue(1),
			v.maxValue(50),
			v.description(
				'Maximum number of voices to return (default: 20)'
			)
		)
	)
})

type BrowseVoiceCatalogParams = v.InferOutput<
	typeof browseVoiceCatalogParams
>

// ── ElevenLabs API types ─────────────────────────────────────────────────

interface ElevenLabsVoice {
	voice_id: string
	name: string
	category?: string
	description?: string
	preview_url?: string
	labels?: Record<string, string>
	settings?: {
		stability?: number
		similarity_boost?: number
		style?: number
		speed?: number
		use_speaker_boost?: boolean
	}
}

interface ElevenLabsVoicesResponse {
	voices: ElevenLabsVoice[]
	has_more?: boolean
	total_count?: number
}

// ── Cache ────────────────────────────────────────────────────────────────

let cachedVoices: ElevenLabsVoice[] | undefined
let cacheExpiresAt = 0

// ── Helpers ──────────────────────────────────────────────────────────────

function errorResult(msg: string): AgentToolResult {
	return {
		content: [
			{
				type: 'text',
				text: `Voice catalog error: ${msg}`
			}
		],
		details: { success: false, error: msg }
	}
}

function formatVoice(v: ElevenLabsVoice): string {
	const lines = [`**${v.name}** (${v.voice_id})`]
	if (v.category) lines.push(`  Category: ${v.category}`)
	if (v.description)
		lines.push(`  Description: ${v.description}`)
	if (v.labels && Object.keys(v.labels).length > 0) {
		const tags = Object.entries(v.labels)
			.map(([k, val]) => `${k}: ${val}`)
			.join(', ')
		lines.push(`  Labels: ${tags}`)
	}
	if (v.preview_url)
		lines.push(`  Preview: ${v.preview_url}`)
	return lines.join('\n')
}

async function fetchVoiceCatalog(
	apiKey: string,
	signal?: AbortSignal
): Promise<ElevenLabsVoice[]> {
	const allVoices: ElevenLabsVoice[] = []
	let pageToken: string | undefined

	// Paginate through all voices
	for (let page = 0; page < 10; page++) {
		const url = new URL(`${ELEVENLABS_BASE_URL}/v2/voices`)
		url.searchParams.set('page_size', '100')
		url.searchParams.set('include_total_count', 'false')
		if (pageToken) {
			url.searchParams.set('next_page_token', pageToken)
		}

		const timeoutSignal = AbortSignal.timeout(
			DEFAULT_TIMEOUT_MS
		)
		const fetchSignal = signal
			? AbortSignal.any([signal, timeoutSignal])
			: timeoutSignal

		const res = await fetch(url.toString(), {
			method: 'GET',
			headers: {
				'xi-api-key': apiKey,
				Accept: 'application/json'
			},
			signal: fetchSignal
		})

		if (!res.ok) {
			throw new Error(
				`ElevenLabs API error (${res.status})`
			)
		}

		const data =
			(await res.json()) as ElevenLabsVoicesResponse
		if (data.voices?.length) {
			allVoices.push(...data.voices)
		}
		if (!data.has_more) break
		pageToken = (data as unknown as Record<string, unknown>)
			.next_page_token as string | undefined
		if (!pageToken) break
	}

	return allVoices
}

// ── Tool factory ─────────────────────────────────────────────────────────

export function createBrowseVoiceCatalogTool(
	credentialsPath?: string
): AgentTool | null {
	if (!credentialsPath) return null

	let cachedApiKey: string | null | undefined

	async function getApiKey(): Promise<string | null> {
		if (cachedApiKey !== undefined) return cachedApiKey
		const cred = await loadElevenLabsCredential(
			credentialsPath!
		)
		cachedApiKey = cred?.key ?? null
		return cachedApiKey
	}

	return {
		name: 'browse_voice_catalog',
		description:
			'Search the ElevenLabs voice catalog by name, description, labels, or category. ' +
			'Returns voice IDs, names, categories, and descriptions. ' +
			'Use this to find voices before setting a default or using a voice override.',
		label: 'Browsing voice catalog',
		parameters: browseVoiceCatalogParams,
		execute: async (
			_toolCallId,
			rawParams,
			signal
		): Promise<AgentToolResult> => {
			const params = rawParams as BrowseVoiceCatalogParams

			try {
				const apiKey = await getApiKey()
				if (!apiKey) {
					return errorResult(
						'ElevenLabs API key not configured. ' +
							'Add an "elevenlabs" entry to .credentials.json: ' +
							'{ "elevenlabs": { "type": "api_key", "key": "YOUR_KEY" } }'
					)
				}

				// Fetch and cache the full catalog
				if (!cachedVoices || Date.now() > cacheExpiresAt) {
					cachedVoices = await fetchVoiceCatalog(
						apiKey,
						signal
					)
					cacheExpiresAt = Date.now() + CACHE_TTL_MS
				}

				let results = cachedVoices

				// Filter by category
				if (params.category) {
					results = results.filter(
						v =>
							v.category?.toLowerCase() ===
							params.category!.toLowerCase()
					)
				}

				// Filter by search query (name, description, labels)
				if (params.query) {
					const q = params.query.toLowerCase()
					results = results.filter(v => {
						if (v.name?.toLowerCase().includes(q))
							return true
						if (v.description?.toLowerCase().includes(q))
							return true
						if (v.labels) {
							for (const val of Object.values(v.labels)) {
								if (val.toLowerCase().includes(q))
									return true
							}
						}
						return false
					})
				}

				const limit = params.limit ?? 20
				const total = results.length
				results = results.slice(0, limit)

				if (!results.length) {
					return {
						content: [
							{
								type: 'text',
								text: params.query
									? `No voices found matching "${params.query}".`
									: 'No voices found.'
							}
						],
						details: {
							success: true,
							total: 0
						}
					}
				}

				const header = `Found ${total} voice${total !== 1 ? 's' : ''} (showing ${results.length}):\n`
				const formatted = results
					.map(formatVoice)
					.join('\n\n')

				return {
					content: [
						{
							type: 'text',
							text: header + formatted
						}
					],
					details: {
						success: true,
						total,
						shown: results.length,
						cached: true
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return errorResult(msg)
			}
		}
	}
}
