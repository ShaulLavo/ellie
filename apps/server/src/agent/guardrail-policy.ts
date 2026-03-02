/**
 * Guardrail policy builder — converts server env vars to a typed AgentGuardrailPolicy.
 *
 * Parsing rules:
 * - Unset, empty, "0", or negative values → disabled (undefined).
 * - Non-numeric values → disabled (logged as warning).
 */

import type { AgentGuardrailPolicy } from '@ellie/agent'
import type { ServerEnv } from '@ellie/env/server'

/** Parse an optional env string to a positive number, or undefined if disabled. */
function parsePositiveNumber(
	raw: string | undefined,
	label: string
): number | undefined {
	if (raw === undefined || raw === '') return undefined
	const n = Number(raw)
	if (Number.isNaN(n)) {
		console.warn(
			`[guardrail-policy] invalid numeric value for ${label}: "${raw}" — disabled`
		)
		return undefined
	}
	return n > 0 ? n : undefined
}

/**
 * Build an AgentGuardrailPolicy from server environment variables.
 * Returns undefined if no limits are configured.
 */
export function buildGuardrailPolicy(
	env: ServerEnv
): AgentGuardrailPolicy | undefined {
	const maxWallClockMs = parsePositiveNumber(
		env.AGENT_LIMIT_MAX_WALL_CLOCK_MS,
		'AGENT_LIMIT_MAX_WALL_CLOCK_MS'
	)
	const maxModelCalls = parsePositiveNumber(
		env.AGENT_LIMIT_MAX_MODEL_CALLS,
		'AGENT_LIMIT_MAX_MODEL_CALLS'
	)
	const maxCostUsd = parsePositiveNumber(
		env.AGENT_LIMIT_MAX_COST_USD,
		'AGENT_LIMIT_MAX_COST_USD'
	)

	if (
		maxWallClockMs === undefined &&
		maxModelCalls === undefined &&
		maxCostUsd === undefined
	) {
		return undefined
	}

	return {
		runtimeLimits: {
			maxWallClockMs,
			maxModelCalls,
			maxCostUsd
		}
	}
}
