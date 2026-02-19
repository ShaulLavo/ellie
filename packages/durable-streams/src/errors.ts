export type StoreErrorCode =
  | 'not_found'
  | 'already_exists'
  | 'sequence_conflict'
  | 'content_type_mismatch'
  | 'invalid_json'
  | 'empty_array'

export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'StoreError'
  }
}

export const STORE_ERROR_STATUS: Record<StoreErrorCode, number> = {
  not_found: 404,
  already_exists: 409,
  sequence_conflict: 409,
  content_type_mismatch: 409,
  invalid_json: 400,
  empty_array: 400,
}
