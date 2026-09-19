/** Released plugin context metadata survives reading, migration publication, and resumed writes. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

describe.each(['none', 'zstd'] as const)('released context summaries (%s)', (compression) => {
  it.each([0, 1, 2])('restores v%i metadata unchanged and appends beside the original generation', async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-summary-'))
    const ctx = new Context()
    const id = SessionId('context-summary')
    try {
      const header = { type: 'session', version, id, createdAt: 1, delegationDepth: 0, ...(version === 2 ? { isSeeded: false } : {}) }
      const messages = ['instructions', 'recall'].map((form, index) => ({
        id: `context-${index}`, role: 'user',
        content: [{ type: 'text', text: `Synthetic ${form} content` }],
        source: { kind: 'plugin', plugin: 'fixture-context', form, summary: `Synthetic ${form} summary` },
      }))
      const rows = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        ...messages.map(data => ({ type: 'user/message', data, surfaceOp: 'append' })),
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'session/end-seed', data: {} },
      ].map((row, seq) => ({ ...row, seq, time: seq + 1 }))
      const headerLine = JSON.stringify(header) + '\n'
      const eventLines = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
      const original = compression === 'zstd'
        ? Buffer.concat([await compressZstdFrame(headerLine), await compressZstdFrame(eventLines)])
        : Buffer.from(headerLine + eventLines)
      const path = generationLogPath(root, undefined, id, version, compression)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, original)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })

      {
        await using reader = await ctx.sessionPersistence.open(id, 'read')
        const events = (await reader.read()).events
        expect(events.filter(event => event.type === 'user/message').map(event => event.data)).toEqual(messages)
        expect(await readdir(dirname(path))).toEqual([path.slice(dirname(path).length + 1)])
      }
      {
        await using writer = await ctx.sessionPersistence.open(id, 'write')
        const read = await writer.read()
        const session = Session.fromRestore(id, read.events, writer.header, writer.inheritedEventCount, read.eventState)
        expect(session.deriveMessages()).toEqual(messages)
        const resume = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Continue after upgrade' }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        await writer.append([resume])
        await writer.flush()
        expect(resume.seq).toBeGreaterThanOrEqual(read.events.length)
      }
      {
        await using reopened = await ctx.sessionPersistence.open(id, 'read')
        const messagesAfter = (await reopened.read()).events.filter(event => event.type === 'user/message')
        expect(messagesAfter.slice(0, 2).map(event => event.data)).toEqual(messages)
        expect(messagesAfter.at(-1)?.data.content).toEqual([{ type: 'text', text: 'Continue after upgrade' }])
      }
      expect(await readFile(path)).toEqual(original)
      expect(await readdir(dirname(path))).toContain(compression === 'zstd' ? 'session.v3.jsonl.zstd' : 'session.v3.jsonl')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
