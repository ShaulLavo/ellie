/**
 * Encode data for SSE format.
 * Per SSE spec, each line in the payload needs its own "data:" prefix.
 * This prevents CRLF injection attacks.
 */
export function encodeSSEData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`
}
