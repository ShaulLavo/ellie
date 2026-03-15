/**
 * Web search tool — Brave Search API.
 *
 * Supports region-specific / localized search, freshness filtering,
 * and in-memory caching with configurable TTL.
 */

import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import { loadBraveCredential } from '@ellie/ai/credentials'
import {
	webSearchParams,
	type WebSearchParams
} from './schema'
import { wrapExternalContent } from '../web-fetch/common'

const BRAVE_SEARCH_ENDPOINT =
	'https://api.search.brave.com/res/v1/web/search'

const DEFAULT_SEARCH_COUNT = 5
const MAX_SEARCH_COUNT = 10
const DEFAULT_TIMEOUT_MS = 30_000

const CACHE_TTL_MS = 15 * 60_000 // 15 minutes
const CACHE_MAX_ENTRIES = 100

const BRAVE_FRESHNESS_SHORTCUTS = new Set([
	'pd',
	'pw',
	'pm',
	'py'
])
const BRAVE_FRESHNESS_RANGE =
	/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/

function isValidIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const [year, month, day] = value
		.split('-')
		.map(p => parseInt(p, 10))
	if (
		!Number.isFinite(year) ||
		!Number.isFinite(month) ||
		!Number.isFinite(day)
	)
		return false

	const date = new Date(Date.UTC(year, month - 1, day))
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	)
}

function normalizeFreshness(
	value: string | undefined
): string | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined

	const lower = trimmed.toLowerCase()
	if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return lower

	const match = trimmed.match(BRAVE_FRESHNESS_RANGE)
	if (!match) return undefined

	const [, start, end] = match
	if (!isValidIsoDate(start) || !isValidIsoDate(end))
		return undefined
	if (start > end) return undefined

	return `${start}to${end}`
}

type CacheEntry = {
	value: Record<string, unknown>
	expiresAt: number
}

const searchCache = new Map<string, CacheEntry>()

function normalizeCacheKey(value: string): string {
	return value.trim().toLowerCase()
}

function readCache(
	key: string
): Record<string, unknown> | null {
	const entry = searchCache.get(key)
	if (!entry) return null
	if (Date.now() > entry.expiresAt) {
		searchCache.delete(key)
		return null
	}
	return entry.value
}

function writeCache(
	key: string,
	value: Record<string, unknown>
): void {
	if (searchCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = searchCache.keys().next()
		if (!oldest.done) searchCache.delete(oldest.value)
	}
	searchCache.set(key, {
		value,
		expiresAt: Date.now() + CACHE_TTL_MS
	})
}

type BraveSearchResult = {
	title?: string
	url?: string
	description?: string
	age?: string
}

type BraveSearchResponse = {
	web?: {
		results?: BraveSearchResult[]
	}
}

function resolveSiteName(
	url: string | undefined
): string | undefined {
	if (!url) return undefined
	try {
		return new URL(url).hostname
	} catch {
		return undefined
	}
}

function resolveCount(value: number | undefined): number {
	const raw = value ?? DEFAULT_SEARCH_COUNT
	return Math.max(
		1,
		Math.min(MAX_SEARCH_COUNT, Math.floor(raw))
	)
}

function errorResult(msg: string): AgentToolResult {
	return {
		content: [
			{ type: 'text', text: `Web search error: ${msg}` }
		],
		details: { success: false, error: msg }
	}
}

async function runBraveSearch(params: {
	query: string
	count: number
	apiKey: string
	signal?: AbortSignal
	country?: string
	search_lang?: string
	ui_lang?: string
	freshness?: string
}): Promise<Record<string, unknown>> {
	const cacheKey = normalizeCacheKey(
		`brave:${params.query}:${params.count}:${params.country || 'default'}:${params.search_lang || 'default'}:${params.ui_lang || 'default'}:${params.freshness || 'default'}`
	)
	const cached = readCache(cacheKey)
	if (cached) return { ...cached, cached: true }

	const start = Date.now()

	const url = new URL(BRAVE_SEARCH_ENDPOINT)
	url.searchParams.set('q', params.query)
	url.searchParams.set('count', String(params.count))
	if (params.country)
		url.searchParams.set('country', params.country)
	if (params.search_lang)
		url.searchParams.set('search_lang', params.search_lang)
	if (params.ui_lang)
		url.searchParams.set('ui_lang', params.ui_lang)
	if (params.freshness)
		url.searchParams.set('freshness', params.freshness)

	// Compose timeout with external signal
	const timeoutSignal = AbortSignal.timeout(
		DEFAULT_TIMEOUT_MS
	)
	const fetchSignal = params.signal
		? AbortSignal.any([params.signal, timeoutSignal])
		: timeoutSignal

	const res = await fetch(url.toString(), {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			'X-Subscription-Token': params.apiKey
		},
		signal: fetchSignal
	})

	if (!res.ok) {
		const detail = await res
			.text()
			.then(t => t.slice(0, 64_000))
			.catch(() => '')
		throw new Error(
			`Brave Search API error (${res.status}): ${detail || res.statusText}`
		)
	}

	const data = (await res.json()) as BraveSearchResponse
	const results = Array.isArray(data.web?.results)
		? (data.web?.results ?? [])
		: []

	const mapped = results.map(entry => {
		const description = entry.description ?? ''
		const title = entry.title ?? ''
		const entryUrl = entry.url ?? ''
		return {
			title,
			url: entryUrl,
			description,
			published: entry.age || undefined,
			siteName: resolveSiteName(entryUrl) || undefined
		}
	})

	const payload: Record<string, unknown> = {
		query: params.query,
		provider: 'brave',
		count: mapped.length,
		tookMs: Date.now() - start,
		results: mapped
	}
	writeCache(cacheKey, payload)
	return payload
}

/**
 * Create the web search tool.
 * The API key is loaded lazily from .credentials.json on first use.
 * Always registers the tool — returns an error at execution time if
 * no key is configured (so the agent knows the tool exists but needs setup).
 */
export function createWebSearchTool(
	credentialsPath?: string
): AgentTool | null {
	if (!credentialsPath) return null

	// Cache the loaded key so we only read the file once
	let cachedApiKey: string | null | undefined

	async function getApiKey(): Promise<string | null> {
		if (cachedApiKey !== undefined) return cachedApiKey
		const cred = await loadBraveCredential(credentialsPath!)
		cachedApiKey = cred?.key ?? null
		return cachedApiKey
	}

	return {
		name: 'search_web',
		description:
			'Search the web using Brave Search API. ' +
			'Supports region-specific and localized search via country and language parameters. ' +
			'Returns titles, URLs, and snippets for fast research.',
		label: 'Searching the web',
		parameters: webSearchParams,
		execute: async (
			_toolCallId,
			rawParams,
			signal
		): Promise<AgentToolResult> => {
			const params = rawParams as WebSearchParams

			try {
				const apiKey = await getApiKey()
				if (!apiKey) {
					return errorResult(
						'web_search needs a Brave Search API key. ' +
							'Add a "brave" entry to .credentials.json: ' +
							'{ "brave": { "type": "api_key", "key": "YOUR_KEY" } }'
					)
				}

				// Validate freshness
				const freshness = params.freshness
					? normalizeFreshness(params.freshness)
					: undefined
				if (params.freshness && !freshness) {
					return errorResult(
						'freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.'
					)
				}

				const result = await runBraveSearch({
					query: params.query,
					count: resolveCount(params.count),
					apiKey,
					signal,
					country: params.country,
					search_lang: params.search_lang,
					ui_lang: params.ui_lang,
					freshness
				})

				// Format results as readable text for the model
				const results = result.results as Array<{
					title: string
					url: string
					description: string
					published?: string
					siteName?: string
				}>

				if (!results?.length) {
					return {
						content: [
							{
								type: 'text',
								text: `No results found for: ${params.query}`
							}
						],
						details: result
					}
				}

				const lines: string[] = []
				for (let i = 0; i < results.length; i++) {
					const r = results[i]
					lines.push(
						`${i + 1}. ${r.title}`,
						`   ${r.url}`,
						`   ${r.description}`
					)
					if (r.published) {
						lines.push(`   Published: ${r.published}`)
					}
					lines.push('')
				}

				return wrapExternalContent({
					content: [
						{
							type: 'text',
							text: lines.join('\n').trim()
						}
					],
					details: result
				})
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return errorResult(msg)
			}
		}
	}
}
