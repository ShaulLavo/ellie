/**
 * Tus protocol header validation.
 * Adapted from tus-node-server (MIT) — see ATTRIBUTION.md
 */

import { TUS_RESUMABLE, TUS_VERSION } from './constants'
import * as Metadata from './metadata'

type Validator = (value?: string) => boolean

const validators = new Map<string, Validator>([
	[
		'upload-offset',
		value => {
			const n = Number(value)
			return (
				Number.isInteger(n) && String(n) === value && n >= 0
			)
		}
	],
	[
		'upload-length',
		value => {
			const n = Number(value)
			return (
				Number.isInteger(n) && String(n) === value && n >= 0
			)
		}
	],
	['upload-defer-length', value => value === '1'],
	[
		'upload-metadata',
		value => {
			try {
				Metadata.parse(value)
				return true
			} catch {
				return false
			}
		}
	],
	[
		'x-forwarded-proto',
		value => value === 'http' || value === 'https'
	],
	[
		'tus-version',
		value => {
			return (TUS_VERSION as readonly string[]).includes(
				value ?? ''
			)
		}
	],
	['tus-resumable', value => value === TUS_RESUMABLE],
	[
		'content-type',
		value => value === 'application/offset+octet-stream'
	]
])

export function validateHeader(
	name: string,
	value?: string | null
): boolean {
	const lowercaseName = name.toLowerCase()
	const validator = validators.get(lowercaseName)
	if (!validator) return true
	return validator(value ?? undefined)
}
