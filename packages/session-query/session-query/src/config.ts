/** Public configuration and typed failures for the combined session-query service. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Default maximum `before`/`after` raw-event window. */
export const SESSION_QUERY_READ_WINDOW_MAX = 50

/** Default maximum number of concurrent persisted-log reads in one batch read. */
export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4

/** Default maximum number of cold prepared-Session observations retained for reuse. */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/** Default decoded-log weight budget for retained cold observations (32 MiB). */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_BYTES = 32 * 1024 * 1024

/** Backend-independent configuration inherited by every session-query implementation. */
export interface Config {
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number
  /** Maximum concurrent persisted-log reads in one batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /**
   * Maximum cold prepared-Session observations retained for reuse, keyed by
   * durable revision. Active leases count toward this bound but remain protected
   * from eviction until released, so they may temporarily exceed it. Defaults to 5.
   */
  preparedSessionCacheSize?: number
  /**
   * Maximum estimated decoded-log bytes retained across cold observations.
   * Active leases may exceed the budget until disposal. Zero disables retention
   * after the final lease. Defaults to 33554432 (32 MiB); not a process heap limit.
   */
  preparedSessionCacheMaxBytes?: number
}

/** Stable machine-routable failure taxonomy for session reads, traces, and search. */
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

/** Typed session-query failure whose `code` is one closed taxonomy member. */
export class SessionQueryError extends HarnessError {
  declare readonly code: SessionQueryErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
