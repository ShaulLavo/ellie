/**
 * Bootstrap — ensures the synthetic BOOTSTRAP.md tool-read is injected
 * exactly once per workspace lifetime.
 *
 * On first ever message, injects two synthetic events into the session:
 *   1. tool_call  — assistant requests read_workspace_file(BOOTSTRAP.md)
 *   2. tool_result — contains the BOOTSTRAP.md content
 *
 * These events use dedupeKeys to guarantee exactly-once semantics.
 * The bootstrap state in DB tracks whether injection has occurred
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
	store: RealtimeStore
	eventStore: EventStore
	workspaceDir: string
}): boolean {
	const { sessionId, store, eventStore, workspaceDir } =
		opts

	// Atomic claim — returns false if already injected
	const claimed = eventStore.claimBootstrapInjection(
		AGENT_ID,
		sessionId
	)
	if (!claimed) return false

	console.log(
		`[bootstrap] injecting synthetic bootstrap into session=${sessionId}`
	)

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
		// 1. Append synthetic tool_call event
		store.appendEvent(
			sessionId,
			'tool_call',
			{
				id: 'bootstrap-read-v1',
				name: 'read_workspace_file',
				arguments: { path: 'BOOTSTRAP.md' }
			},
			undefined, // no runId — synthetic
			'bootstrap:v1:tool_call'
		)

		// 2. Append synthetic tool_result event
		store.appendEvent(
			sessionId,
			'tool_result',
			{
				role: 'toolResult',
				toolCallId: 'bootstrap-read-v1',
				toolName: 'read_workspace_file',
				content: [{ type: 'text', text: bootstrapContent }],
				details: {
					synthetic: true,
					bootstrap: true,
					path: 'BOOTSTRAP.md'
				},
				isError: false,
				timestamp: Date.now()
			},
			undefined, // no runId — synthetic
			'bootstrap:v1:tool_result'
		)

		console.log(
			`[bootstrap] synthetic bootstrap injected into session=${sessionId}`
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
