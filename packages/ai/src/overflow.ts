/**
 * Context overflow detection — backward-compatible re-exports from errors.ts.
 *
 * The canonical implementation now lives in errors.ts alongside all other
 * error classification logic. This file preserves the original export names.
 */
export {
	isContextOverflowError as isContextOverflow,
	getOverflowPatterns
} from './errors'
