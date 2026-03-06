/**
 * Shared helper for creating REPL trace dependencies and scope setter.
 *
 * Used by both exec-tool and session-exec-tool to avoid duplicating
 * the activeReplScope / replTraceDeps / setActiveReplScope pattern.
 */

import type {
	BlobSink,
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import type { ReplTraceDeps } from '../../repl/repl-runtime'

export interface ReplTraceDepsResult {
	replTraceDeps: ReplTraceDeps | undefined
	setActiveReplScope:
		| ((scope: TraceScope | undefined) => void)
		| undefined
}

export function createReplTraceDeps(traceDeps?: {
	recorder: TraceRecorder
	blobSink?: BlobSink
}): ReplTraceDepsResult {
	if (!traceDeps) {
		return {
			replTraceDeps: undefined,
			setActiveReplScope: undefined
		}
	}

	let activeReplScope: TraceScope | undefined

	return {
		replTraceDeps: {
			recorder: traceDeps.recorder,
			blobSink: traceDeps.blobSink,
			getParentScope: () => activeReplScope
		},
		setActiveReplScope: (scope: TraceScope | undefined) => {
			activeReplScope = scope
		}
	}
}
