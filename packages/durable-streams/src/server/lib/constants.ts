// Protocol headers
export const STREAM_OFFSET_HEADER = `Stream-Next-Offset`;
export const STREAM_CURSOR_HEADER = `Stream-Cursor`;
export const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`;
export const STREAM_SEQ_HEADER = `Stream-Seq`;
export const STREAM_TTL_HEADER = `Stream-TTL`;
export const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`;
export const STREAM_SSE_DATA_ENCODING_HEADER = `Stream-SSE-Data-Encoding`;
export const STREAM_CLOSED_HEADER = `Stream-Closed`;
export const STREAM_RESURRECT_HEADER = `Stream-Resurrect`;

// Idempotent producer headers
export const PRODUCER_ID_HEADER = `Producer-Id`;
export const PRODUCER_EPOCH_HEADER = `Producer-Epoch`;
export const PRODUCER_SEQ_HEADER = `Producer-Seq`;
export const PRODUCER_EXPECTED_SEQ_HEADER = `Producer-Expected-Seq`;
export const PRODUCER_RECEIVED_SEQ_HEADER = `Producer-Received-Seq`;

// SSE control event fields
export const SSE_OFFSET_FIELD = `streamNextOffset`;
export const SSE_CURSOR_FIELD = `streamCursor`;
export const SSE_UP_TO_DATE_FIELD = `upToDate`;
export const SSE_CLOSED_FIELD = `streamClosed`;

// Query params
export const OFFSET_QUERY_PARAM = `offset`;
export const LIVE_QUERY_PARAM = `live`;
export const CURSOR_QUERY_PARAM = `cursor`;

// CORS / security headers for durable stream responses
export function setDurableStreamHeaders(
  headers: Record<string, string | number>
): void {
  headers[`access-control-allow-origin`] = `*`;
  headers[`access-control-allow-methods`] =
    `GET, POST, PUT, DELETE, HEAD, OPTIONS`;
  headers[`access-control-allow-headers`] =
    `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Stream-Resurrect, Producer-Id, Producer-Epoch, Producer-Seq`;
  headers[`access-control-expose-headers`] =
    `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`;
  headers[`x-content-type-options`] = `nosniff`;
  headers[`cross-origin-resource-policy`] = `cross-origin`;
}
