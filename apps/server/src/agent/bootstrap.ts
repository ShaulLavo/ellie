/**
 * Bootstrap — ensures the synthetic BOOTSTRAP.md tool-read is injected
 * exactly once per workspace lifetime.
 *
 * On first ever message, injects a single completed tool_execution event
 * containing the BOOTSTRAP.md content. Uses a dedupeKey for exactly-once
 * semantics. The bootstrap state in DB tracks whether injection has occurred
 * globally (not per-session).
 */

import type { EventStore } from '@ellie/db'
import type { RealtimeStore } from '../lib/realtime-store'
import { readWorkspaceFile } from './workspace'

const AGENT_ID = 'main'

/**
 * Ensure bootstrap has been injected. Call before persisting the
 * first user message in a session.
 *
 * Returns true if bootstrap was injected in this call, false if
 * already done (or not needed).
 */
export function ensureBootstrapInjected(opts: {
	sessionId: string
	runId: string
	store: RealtimeStore
	eventStore: EventStore
	workspaceDir: string
}): boolean {
	const {
		sessionId,
		runId,
		store,
		eventStore,
		workspaceDir
	} = opts

	// Atomic claim — returns false if already injected
	const claimed = eventStore.claimBootstrapInjection(
		AGENT_ID,
		sessionId
	)
	if (!claimed) return false

	const bootstrapContent = readWorkspaceFile(
		workspaceDir,
		'BOOTSTRAP.md'
	)
	if (!bootstrapContent) {
		eventStore.markBootstrapError(
			AGENT_ID,
			'BOOTSTRAP.md not found in workspace'
		)
		console.error(
			'[bootstrap] BOOTSTRAP.md not found in workspace'
		)
		return false
	}

	try {
		// Append a single completed tool_execution event
		store.appendEvent(
			sessionId,
			'tool_execution',
			{
				toolCallId: 'bootstrap-read-v1',
				toolName: 'read_workspace_file',
				args: { path: 'BOOTSTRAP.md' },
				result: {
					content: [
						{ type: 'text', text: bootstrapContent }
					],
					details: {
						synthetic: true,
						bootstrap: true,
						path: 'BOOTSTRAP.md'
					}
				},
				isError: false,
				status: 'complete'
			},
			runId,
			'bootstrap:v2:tool_execution'
		)

		return true
	} catch (err) {
		const msg =
			err instanceof Error ? err.message : String(err)
		eventStore.markBootstrapError(AGENT_ID, msg)
		console.error(`[bootstrap] injection failed: ${msg}`)
		return false
	}
}

/**
 * Check if bootstrap has already been injected for the global agent.
 */
export function isBootstrapInjected(
	eventStore: EventStore
): boolean {
	const state = eventStore.getBootstrapState(AGENT_ID)
	return state?.bootstrapInjectedAt != null
}
