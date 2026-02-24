/**
 * Shared stream schemas used by the app router and client apps.
 */

import * as v from 'valibot'

// ============================================================================
// Stream Schemas
// ============================================================================

export const messageSchema = v.object({
	id: v.string(),
	role: v.picklist([`user`, `assistant`, `system`]),
	content: v.string(),
	createdAt: v.string()
})
