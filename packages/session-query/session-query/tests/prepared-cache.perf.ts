/** Threshold-free retained-heap diagnostic for navigation across synthetic cold Sessions. */

import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import { SessionObservationReader } from '../src/observation.ts'

const sessionCount = 10
const eventsPerSession = 512
const charsPerMessage = 16 * 1024
const unbounded = process.argv.includes('--unbounded')
const payload = JSON.stringify(createUserMessage({
  content: [{ type: 'text', text: 'synthetic observation payload\n'.repeat(1024).slice(0, charsPerMessage) }],
  source: { kind: 'user' },
}))
const ctx = new Context()
await ctx.plugin(SessionStore)
let reads = 0
const header = (id: SessionIdType) => ({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
ctx.provide('sessionPersistence', {
  stat: (id: SessionIdType) => Promise.resolve({ header: header(id), revision: SessionPersistenceRevision('fixed') }),
  open: (id: SessionIdType) => Promise.resolve({
    id,
    header: header(id),
    access: 'read',
    inheritedEventCount: SessionLogOffset(0),
    read: () => {
      reads += 1
      const events: SessionEvent[] = Array.from({ length: eventsPerSession }, (_, seq) => ({
        type: 'user/message',
        seq: SessionSeq(seq),
        time: seq,
        data: JSON.parse(payload) as ReturnType<typeof createUserMessage>,
        surfaceOp: 'append',
      }))
      return Promise.resolve({ events, eventState: 'detached' })
    },
    close: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }),
} as unknown as SessionPersistence)

const reader = new SessionObservationReader(
  ctx,
  5,
  unbounded ? Number.MAX_SAFE_INTEGER : 32 * 1024 * 1024,
)
const collect = (): void => {
  assert(globalThis.gc, 'run the built diagnostic with node --expose-gc')
  globalThis.gc()
  globalThis.gc()
}
const observe = async (index: number): Promise<void> => {
  using observed = await reader.read(SessionId(`synthetic-${index}`), { projectionMode: 'none' })
  assert.equal(observed.events.length, eventsPerSession)
  assert.equal(observed.cursor, eventsPerSession - 1)
}

try {
  collect()
  const baseline = process.memoryUsage()
  const start = performance.now()
  for (let index = 0; index < sessionCount; index += 1) await observe(index)
  const navigationMs = performance.now() - start
  collect()
  const retained = process.memoryUsage()
  assert.equal(reads, sessionCount)
  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    sessionCount,
    eventsPerSession,
    charsPerMessage,
    cache: unbounded ? 'unbounded-control' : '32MiB',
    navigationMs,
    retainedHeapMiB: (retained.heapUsed - baseline.heapUsed) / 1024 ** 2,
    retainedRssMiB: (retained.rss - baseline.rss) / 1024 ** 2,
  }))
  await observe(sessionCount - 1)
  assert.equal(reads, sessionCount)
} finally {
  await ctx.fiber.dispose()
}
