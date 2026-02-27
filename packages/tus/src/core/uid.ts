/**
 * Upload ID generation using ULID from @ellie/utils.
 */

import { ulid } from '@ellie/utils'

export const Uid = {
	rand(): string {
		return ulid()
	}
}
