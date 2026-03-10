/**
 * Valibot schema for WhatsApp channel settings.
 * Single source of truth for defaults and validation.
 */

import * as v from 'valibot'

const dmPolicySchema = v.picklist([
	'pairing',
	'allowlist',
	'open',
	'disabled'
])

const groupPolicySchema = v.picklist([
	'allowlist',
	'open',
	'disabled'
])

// ── Tool policy schemas (matching OpenCLAW's ToolPolicyConfig) ──────────

const toolPolicySchema = v.union([
	v.picklist(['all', 'none']),
	v.object({
		allow: v.optional(v.array(v.string())),
		deny: v.optional(v.array(v.string()))
	})
])

// ── Per-group config schema (matching OpenCLAW's ChannelGroupConfig) ────

const groupConfigSchema = v.object({
	requireMention: v.optional(v.boolean()),
	tools: v.optional(toolPolicySchema),
	toolsBySender: v.optional(
		v.record(v.string(), toolPolicySchema)
	)
})

export const whatsappSettingsSchema = v.pipe(
	v.object({
		selfChatMode: v.optional(v.boolean(), false),
		dmPolicy: v.optional(dmPolicySchema, 'pairing'),
		allowFrom: v.optional(v.array(v.string()), []),
		groupPolicy: v.optional(groupPolicySchema, 'disabled'),
		groupAllowFrom: v.optional(v.array(v.string()), []),
		groups: v.optional(
			v.record(v.string(), groupConfigSchema),
			{}
		),
		sendReadReceipts: v.optional(v.boolean(), true),
		debounceMs: v.optional(
			v.pipe(v.number(), v.minValue(0)),
			0
		),
		mediaMaxMb: v.optional(
			v.pipe(v.number(), v.minValue(1)),
			50
		),
		historyLimit: v.optional(
			v.pipe(v.number(), v.minValue(0)),
			50
		)
	}),
	v.check(
		s => s.dmPolicy !== 'open' || s.allowFrom.includes('*'),
		'dmPolicy "open" requires allowFrom to include "*"'
	)
)

export type ValidatedWhatsAppSettings = v.InferOutput<
	typeof whatsappSettingsSchema
>
