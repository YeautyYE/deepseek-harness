/** Shared live/prepared observations for Session page and lifecycle consumers. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset as SessionLogOffsetType , SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import {
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_BYTES,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SessionQueryError,
} from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'

/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session or a retained preparation. */
  readonly source: 'live' | 'prepared'
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffsetType
  /**
   * Immutable contiguous events at {@link cursor}. A live observation
   * materializes this array on first read, so a consumer that reads only the
   * header, cursor, or projections never copies the log.
   */
  readonly events: readonly SessionEvent[]
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation
}

/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none'
}

/**
 * One reusable cold observation: an unpublished restored Session plus the
 * exact balanced log it represents, valid while the producing persistence
 * instance still reports the same revision.
 */
interface PreparedEntry {
  /** The persistence instance whose `stat` produced {@link revision}; revisions from another instance are incomparable. */
  readonly persistence: SessionPersistence
  /** Durable revision observed by `stat` immediately before the log read. */
  readonly revision: SessionPersistenceRevision
  /** Unpublished Session restored from the balanced log; never entered into the store. */
  readonly session: Session
  /** Immutable balanced log (stored events plus in-memory interrupted-turn closers). */
  readonly events: readonly SessionEvent[]
  /** Estimated decoded header/log weight, capped just above the configured budget. */
  readonly bytes: number
  /** Active observation leases; a pinned entry (`refs > 0`) is never evicted. */
  refs: number
}

/**
 * Builds point observations without a corpus listing preflight.
 *
 * Cold reads are cached per session id, keyed by the persistence instance and
 * the `stat` revision observed before the log read: an unchanged revision
 * reuses the restored Session without re-reading the log. The cache is bounded
 * (least-recently-used unpinned entries are evicted past the capacity), and
 * entries pinned by active leases survive eviction and replacement — a lease's
 * cut stays valid for the lease lifetime even after a newer revision lands.
 */
export class SessionObservationReader {
  private readonly cache = new Map<SessionId, PreparedEntry>()
  private cacheBytes = 0

  /**
   * @param ctx - context carrying Session and optional persistence/projection services.
   * @param cacheCapacity - maximum retained cold observations; active leases remain protected from eviction.
   * @param cacheMaxBytes - maximum estimated decoded-log bytes retained after leases release.
   */
  constructor(
    private readonly ctx: Context,
    private readonly cacheCapacity: number = SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
    private readonly cacheMaxBytes: number = SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_MAX_BYTES,
  ) {}

  /**
   * Observe one live-preferred Session and retain a cold preparation until disposal.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and all-or-none projection computation for this read.
   * @returns one exact immutable observation.
   */
  async read(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      throwIfObservationAborted(signal)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.live(live, projectionMode)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)

      const snapshot = await this.statSource(persistence, sessionId, signal)
      const attachedDuringStat = this.ctx.sessions.get(sessionId)
      if (attachedDuringStat !== undefined) return this.live(attachedDuringStat, projectionMode)
      let entry = this.cachedEntry(persistence, sessionId, snapshot.revision)
      if (entry === undefined) {
        const loaded = await this.loadSource(persistence, sessionId, signal)
        throwIfObservationAborted(signal)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) return this.live(attached, projectionMode)
        // The handle marks persisted events as adoptable; synthetic closers
        // are owned by this read, so the combined seed needs no copy.
        const seed = loaded.events
        let session: Session
        try {
          session = this.ctx.sessions.prepare(sessionId, {
            seed,
            meta: structuredClone(loaded.header),
            inheritedEventCount: loaded.inheritedEventCount,
            eventState: loaded.eventState,
          })
        } catch (error: unknown) {
          // The store rejects an id with a live owner: that owner is the
          // fresher source, so retry the live path. Any other rejection means
          // the stored log failed restore validation.
          if (this.ctx.sessions.get(sessionId) !== undefined) continue
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        entry = {
          persistence,
          revision: snapshot.revision,
          session,
          events: Object.freeze(seed),
          bytes: decodedLogWeight([session.header, seed], this.cacheMaxBytes),
          refs: 0,
        }
      }

      let projections: ProjectionSnapshot | undefined
      try {
        projections = projectionMode === 'none' ? undefined : this.preparedProjections(entry)
      } catch (error: unknown) {
        throw new SessionQueryError(
          `failed to project session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_CORRUPT_SESSION',
          { cause: error },
        )
      }
      const observed = this.preparedLease(sessionId, entry, projections)
      this.store(sessionId, entry)
      return observed
    }
  }

  /** Observe the stored snapshot, mapping absence and backend failures to the query taxonomy. */
  private async statSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<SessionPersistenceSnapshot> {
    let snapshot: SessionPersistenceSnapshot | undefined
    try {
      snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
    throwIfObservationAborted(signal)
    if (snapshot === undefined) throw notFound(sessionId)
    if (snapshot.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${snapshot.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    return snapshot
  }

  /** Read the complete balanced cold log, mapping backend failures to the query taxonomy. */
  private async loadSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<ColdSessionLog> {
    try {
      return await readColdSessionLog(persistence, sessionId, signal)
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
  }

  /** Return a still-valid cached entry and mark it most recently used. */
  private cachedEntry(
    persistence: SessionPersistence,
    sessionId: SessionId,
    revision: SessionPersistenceRevision,
  ): PreparedEntry | undefined {
    const cached = this.cache.get(sessionId)
    if (cached === undefined) return undefined
    if (cached.persistence !== persistence || cached.revision !== revision) {
      this.remove(sessionId)
      return undefined
    }
    this.cache.delete(sessionId)
    this.cache.set(sessionId, cached)
    return cached
  }

  /** Insert or replace the entry for one id, then evict past the capacity. */
  private store(sessionId: SessionId, entry: PreparedEntry): void {
    // Replacing a stale revision only drops the map's reference; live leases
    // keep the old entry alive through their own references.
    this.remove(sessionId)
    this.cache.set(sessionId, entry)
    this.cacheBytes += entry.bytes
    this.evictPastCapacity()
  }

  /** Release only cache ownership; outstanding leases keep their immutable data. */
  private remove(sessionId: SessionId): void {
    const entry = this.cache.get(sessionId)
    if (entry === undefined) return
    this.cacheBytes -= entry.bytes
    this.cache.delete(sessionId)
  }

  /**
   * Evict oldest unpinned entries until the cache fits its capacity again.
   * Runs on store and whenever a lease release unpins an entry, so leases
   * that pinned every candidate cannot leave the cache over budget for good.
   */
  private evictPastCapacity(): void {
    if (this.cache.size <= this.cacheCapacity && this.cacheBytes <= this.cacheMaxBytes) return
    for (const [id, candidate] of this.cache) {
      if (candidate.refs > 0) continue
      this.remove(id)
      if (this.cache.size <= this.cacheCapacity && this.cacheBytes <= this.cacheMaxBytes) return
    }
  }

  /** Build one disposable lease over a cached entry, pinning it until every lease releases. */
  private preparedLease(
    sessionId: SessionId,
    entry: PreparedEntry,
    projections: ProjectionSnapshot | undefined,
  ): SessionObservation {
    entry.refs += 1
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'prepared',
        header: entry.session.header,
        inheritedEventCount: entry.session.inheritedEventCount,
        events: entry.events,
        cursor: entry.events.at(-1)?.seq ?? -1,
        revision: entry.revision,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
          entry.refs += 1
          return lease()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          entry.refs -= 1
          if (entry.refs === 0) this.evictPastCapacity()
        },
      }
    }
    return lease()
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    this.remove(session.id)
    // The cut is the log length now. The log only appends, so the prefix
    // below `seq` is the same array whenever a consumer first reads `events`.
    const seq = session.seq
    let materialized: readonly SessionEvent[] | undefined
    const projections = projectionMode === 'none'
      ? undefined
      : this.ctx.get('sessionProjections')?.snapshot(session)
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        get events() {
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          materialized ??= session.snapshotEvents(SessionLogOffset(0), seq)
          return materialized
        },
        cursor: seq === 0 ? -1 : SessionSeq(seq - 1),
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(entry: PreparedEntry): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
      : cache.hydratePrepared(entry.session, entry.events)
  }
}

/** Estimate decoded JSON storage without serializing strings or walking beyond the budget. */
function decodedLogWeight(values: readonly unknown[], limit: number): number {
  let bytes = 0
  const seen = new WeakSet<object>()
  const pending: Iterator<unknown>[] = [values.values()]
  for (let iterator = pending.at(-1); iterator !== undefined; iterator = pending.at(-1)) {
    const next = iterator.next()
    if (next.done === true) {
      pending.pop()
      continue
    }
    const value: unknown = next.value
    if (typeof value === 'string') {
      bytes += 32 + value.length * 2
    } else if (value !== null && typeof value === 'object') {
      if (!seen.has(value)) {
        seen.add(value)
        bytes += 64
        pending.push(Array.isArray(value) ? value.values() : propertyValues(value))
      }
    } else {
      bytes += 8
    }
    // Charge each reference slot, including the prepared Session's log indexes.
    bytes += 16
    if (bytes > limit) return limit + 1
  }
  return bytes
}

function* propertyValues(value: object): Generator {
  for (const key of Object.keys(value)) {
    yield key
    yield (value as Record<string, unknown>)[key]
  }
}

function throwIfObservationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function mapPersistenceFailure(sessionId: SessionId, error: unknown): SessionQueryError {
  if (hasErrorName(error, 'SessionPersistenceNotFoundError')) return notFound(sessionId, error)
  if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      `stored session "${sessionId}" is corrupt: ${error.message}`,
      'SESSION_QUERY_CORRUPT_SESSION',
      { cause: error },
    )
  }
  return new SessionQueryError(
    `failed to observe session "${sessionId}": ${errorMessage(error)}`,
    'SESSION_QUERY_PERSISTENCE_FAILED',
    { cause: error },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}
