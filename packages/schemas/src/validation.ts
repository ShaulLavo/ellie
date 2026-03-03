import * as v from 'valibot'
import type { GenericSchema } from 'valibot'

/**
 * Attempt to re-validate `value` against `validator` using Valibot and return
 * a human-/AI-readable summary of the issues.  Returns `undefined` when the
 * validator is not a Valibot schema or validation unexpectedly succeeds.
 */
export function tryValibotSummary(
	validator: unknown,
	value: unknown
): string | undefined {
	try {
		const result = v.safeParse(
			validator as GenericSchema,
			value
		)
		if (!result.success) return v.summarize(result.issues)
	} catch {
		// not a valibot schema or other error
	}
	return undefined
}
