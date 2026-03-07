/**
 * Fetch cache — deduplicates web fetches by querying recent tool_execution
 * events from the SQLite event store. No new tables needed — tool results
 * are already persisted by stream-persistence.
 */

import { sql, desc, and, gt, eq } from 'drizzle-orm'
import { events } from '@ellie/db/schema'
import type { EventStore } from '@ellie/db'
import type { AgentToolResult } from '@ellie/agent'

const DEFAULT_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Look up a recent successful fetch_page result for the given URL.
 *
 * Returns the cached AgentToolResult if a completed, non-error
 * tool_execution exists within the TTL window, or null on miss.
 */
export function getCachedFetchResult(
	eventStore: EventStore,
	url: string,
	ttlMs = DEFAULT_TTL_MS
): AgentToolResult | null {
	try {
		const minCreatedAt = Date.now() - ttlMs

		const row = eventStore.db
			.select({ payload: events.payload })
			.from(events)
			.where(
				and(
					eq(events.type, 'tool_execution'),
					eq(
						sql`json_extract(${events.payload}, '$.toolName')`,
						'fetch_page'
					),
					eq(
						sql`json_extract(${events.payload}, '$.status')`,
						'complete'
					),
					sql`json_extract(${events.payload}, '$.isError') IS NOT 1`,
					eq(
						sql`json_extract(${events.payload}, '$.args.url')`,
						url
					),
					gt(events.createdAt, minCreatedAt)
				)
			)
			.orderBy(desc(events.createdAt))
			.limit(1)
			.get()

		if (!row) return null

		const payload = JSON.parse(row.payload)
		const result = payload?.result
		if (!result?.content) return null

		return result as AgentToolResult
	} catch {
		// Parse/query errors → cache miss, fetch normally
		return null
	}
}
