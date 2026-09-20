/** Manual retained-heap diagnostic for reading and closing large JSONL histories through built packages. */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const sessionCount = 2
const eventsPerSession = 2048
const textCharacters = 16 * 1024
const version = process.argv.includes('--historical') ? 0 : SESSION_FORMAT_VERSION
const compression = process.argv.includes('--zstd') ? 'zstd' : 'none'
const root = await mkdtemp(join(tmpdir(), 'dsh-cold-log-memory-'))
const ctx = new Context()
const ids = Array.from({ length: sessionCount }, (_, index) => SessionId(`synthetic-memory-${index}`))

async function seed(): Promise<void> {
  for (const id of ids) {
    const dir = join(root, '_no-cwd', id)
    await mkdir(dir, { recursive: true })
    const file = await open(join(dir, `session${version === 0 ? '' : `.v${version}`}.jsonl${compression === 'zstd' ? '.zstd' : ''}`), 'wx', 0o600)
    const encode = (text: string): Buffer | string => compression === 'zstd' ? zstdCompressSync(text) : text
    try {
      await file.writeFile(encode(JSON.stringify({
        type: 'session', version, id, createdAt: 1, ...(version === 0 ? {} : { isSeeded: false }), delegationDepth: 0,
      }) + '\n'))
      if (version === 0) {
        await file.writeFile(encode([
          { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
          { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n'))
      }
      let batch = ''
      for (let seq = 0; seq < eventsPerSession; seq++) {
        batch += JSON.stringify({
          type: 'user/message', seq: seq + (version === 0 ? 2 : 0), time: seq + 2, surfaceOp: 'append',
          data: {
            id: `${id}-${seq}`, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: `${seq}:`.padEnd(textCharacters, 'synthetic history ') }],
          },
        }) + '\n'
        if ((seq + 1) % 64 === 0 || seq + 1 === eventsPerSession) {
          await file.writeFile(encode(batch))
          batch = ''
        }
      }
      if (version === 0) {
        await file.writeFile(encode([
          { type: 'step/end', seq: eventsPerSession + 2, time: eventsPerSession + 2, data: { turn: 1, step: 1 } },
          { type: 'turn/end', seq: eventsPerSession + 3, time: eventsPerSession + 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n'))
      }
    } finally {
      await file.close()
    }
  }
}

async function collect(): Promise<void> {
  assert(globalThis.gc, 'run the built diagnostic with node --expose-gc')
  for (let index = 0; index < 5; index++) {
    await setImmediate()
    globalThis.gc()
  }
}

async function readAndClose(id: ReturnType<typeof SessionId>): Promise<WeakRef<SessionEvent>> {
  await using handle = await ctx.sessionPersistence.open(id, 'read')
  const read = await handle.read()
  assert.equal(read.events.filter(event => event.type === 'user/message').length, eventsPerSession)
  const first = read.events.find(event => event.type === 'user/message')
  assert(first?.type === 'user/message')
  assert.deepEqual(first.data.content, [{ type: 'text', text: '0:'.padEnd(textCharacters, 'synthetic history ') }])
  return new WeakRef(first)
}

try {
  await seed()
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  await collect()
  const baseline = process.memoryUsage().heapUsed
  const references: WeakRef<SessionEvent>[] = []
  const start = performance.now()
  for (const id of ids) references.push(await readAndClose(id))
  const readMs = performance.now() - start
  await collect()
  const retainedHeapMiB = (process.memoryUsage().heapUsed - baseline) / 1024 ** 2
  const retainedLogs = references.filter(reference => reference.deref() !== undefined).length
  for (const id of ids) await readAndClose(id)
  console.log(JSON.stringify({
    node: process.version, platform: `${process.platform}/${process.arch}`,
    version, compression, sessionCount, eventsPerSession, textCharacters, readMs, retainedHeapMiB, retainedLogs,
    reread: 'passed',
  }))
  if (process.argv.includes('--expect-released')) assert.equal(retainedLogs, 0, 'closed histories remain reachable')
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
