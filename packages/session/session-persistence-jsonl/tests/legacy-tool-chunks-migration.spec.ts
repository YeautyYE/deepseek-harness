/** Released partial Tool calls migrate into paired current events without changing source artifacts. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

describe.each(['none', 'zstd'] as const)('released partial Tool-call chunks (%s)', (compression) => {
  it.each([
    [0, '', undefined], [1, '', undefined],
    [0, 'call', ''], [1, 'call', ''],
  ] as const)('preserves v%i packed chunks with id=%j and name=%j', async (version, callId, name) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-partial-tool-chunks-'))
    const ctx = new Context()
    const id = SessionId('partial-tool-chunks')
    try {
      const header = { type: 'session', version, id, createdAt: 1, delegationDepth: 0 }
      const targetId = callId || 'released-v1-tool-1-1-7-0'
      const chunks = [
        { type: 'tool-call-delta', index: 0, id: callId, ...name === undefined ? {} : { name }, argumentsDelta: '{' },
        { type: 'tool-call-delta', index: 0, id: callId, ...name === undefined ? {} : { name }, argumentsDelta: '}' },
      ]
      const rows = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } } },
        { type: 'tool-call-chunks', seq0: 3, time0: 4, data: { turn: 1, step: 1, index: 0, id: callId, ...name === undefined ? {} : { name }, dt: [2], args: ['{', '}'] } },
        { type: 'assistant/chunk', seq: 5, time: 7, data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: name ?? '', arguments: '{}' } } } },
        { type: 'assistant/chunk', seq: 6, time: 8, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } } },
        { type: 'assistant/message', seq: 7, time: 9, data: { turn: 1, step: 1, message: {
          id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          content: [{ type: 'tool-call', id: callId, name: name ?? '', arguments: '{}' }],
        } }, surfaceOp: 'append', sourceEventSeqs: [2, 3, 4, 5, 6] },
        { type: 'tool/call', seq: 8, time: 10, data: { turn: 1, step: 1, callId, name: name ?? '', arguments: '{}' } },
        { type: 'tool/result', seq: 9, time: 11, data: { turn: 1, step: 1, message: {
          id: 'result', role: 'user', source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'Unknown fixture tool' }], isError: true }],
        } }, surfaceOp: 'append', sourceEventSeqs: [8] },
        { type: 'step/end', seq: 10, time: 12, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 11, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      const headerLine = JSON.stringify(header) + '\n'
      const eventLines = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
      const original = compression === 'zstd'
        ? Buffer.concat([await compressZstdFrame(headerLine), await compressZstdFrame(eventLines)])
        : Buffer.from(headerLine + eventLines)
      const path = generationLogPath(root, undefined, id, version, compression)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, original)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      for (const access of ['read', 'write', 'read'] as const) {
        await using handle = await ctx.sessionPersistence.open(id, access)
        const events = (await handle.read()).events
        const message = events.find(event => event.type === 'assistant/message')
        expect(message?.data.stream).toEqual([
          { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
          { type: 'chunk', time: 4, chunk: { ...chunks[0], id: targetId } },
          { type: 'chunk', time: 6, chunk: { ...chunks[1], id: targetId } },
          { type: 'chunk', time: 7, chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', id: targetId, name: name ?? '', arguments: '{}' } } },
          { type: 'chunk', time: 8, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
        ])
        expect(message?.data.message.content).toEqual([{ type: 'tool-call', id: targetId, name: name ?? '', arguments: '{}' }])
        expect(events.find(event => event.type === 'tool/call')?.data).toMatchObject({ callId: targetId, name: name ?? '' })
        expect(events.find(event => event.type === 'tool/result')?.data.message.source).toEqual({ kind: 'tool', callId: targetId })
      }
      expect(await readFile(path)).toEqual(original)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
