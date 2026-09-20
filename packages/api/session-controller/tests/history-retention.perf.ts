/** Retained-heap diagnostic for idle history follows after their opening pages are delivered. */

import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionHistoryController } from '../src/history.ts'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const ctx = new Context()
const eventsPerHistory = 3000
const textCharacters = 6144
const arrays: WeakRef<readonly SessionEvent[]>[] = []
let released = 0
ctx.provide('sessionQuery', {
  observeSession: async (id: ReturnType<typeof SessionId>): Promise<SessionObservation> => {
    const events = Array.from({ length: eventsPerHistory }, (_, seq) => JSON.parse(JSON.stringify({
      type: 'user/message', seq, time: seq, surfaceOp: 'append',
      data: {
        id: `${id}-${seq}`, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: `${id}-${seq}:` + 'abc123'.repeat(textCharacters / 6) }],
      },
    })) as SessionEvent)
    arrays.push(new WeakRef(events))
    const lease = (): SessionObservation => ({
      source: 'prepared',
      header: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: '/fixture', isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
      events,
      cursor: SessionSeq(events.length - 1),
      retain: lease,
      [Symbol.dispose]: () => { released++ },
    })
    return lease()
  },
} as never)
const history = new SessionHistoryController(ctx)
async function collect(): Promise<void> {
  assert(globalThis.gc, 'run the built diagnostic with node --expose-gc')
  for (let i = 0; i < 4; i++) {
    await setImmediate()
    globalThis.gc()
  }
}
await collect()
const baseline = process.memoryUsage().heapUsed
const followers = []
try {
  for (let index = 0; index < 6; index++) {
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: SessionId(`fixture-${index}`) }, maxMessages: 2,
    }, abort.signal)[Symbol.asyncIterator]()
    const opening = await iterator.next()
    assert(!opening.done && opening.value.type === 'snapshot', 'missing opening page')
    assert.equal(opening.value.records.length, 2)
    const waiting = iterator.next()
    followers.push({ abort, iterator, waiting })
  }
  await collect()
  const fullHistoriesAlive = arrays.filter(value => value.deref() !== undefined).length
  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    followers: followers.length,
    eventsPerHistory,
    textCharacters,
    retainedMiB: (process.memoryUsage().heapUsed - baseline) / 1024 ** 2,
    fullHistoriesAlive,
    released,
  }))
  assert.equal(fullHistoriesAlive, 0, 'idle followers retain complete opening logs')
} finally {
  for (const { abort } of followers) abort.abort()
  await Promise.all(followers.map(value => value.waiting))
  await ctx.fiber.dispose()
}
