/**
 * Upload ID generation using ULID from @ellie/utils.
 */

import { ulid } from 'fast-ulid'

export const Uid = {
	rand(): string {
		return ulid()
	}
}
