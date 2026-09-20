/** Ordinary history reads stay cold until an explicit Session command resumes the Agent. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController } from './test-remote.ts'
import type { SessionRequestId, SessionWireEvent } from '../src/types.ts'

class ReplyAdapter extends LlmAdapter {
  calls = 0

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'continued' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'continued' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function persistentHarness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-activation-'))
  const ctx = new Context()
  const dispose = async (): Promise<void> => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await mountAgentLoopTestHarness(ctx)
    const adapter = new ReplyAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: root,
    })
    return {
      ctx, controller, adapter,
      seed: async (id: SessionId, events: readonly SessionEvent[]): Promise<void> => {
        const session = ctx.sessions.prepare(id, { meta: { cwd: root } })
        const stored = await ctx.sessionPersistence.create(session.header)
        try { await stored.append(events) } finally { await stored.close() }
      },
      [Symbol.asyncDispose]: dispose,
    }
  } catch (error: unknown) {
    await dispose()
    throw error
  }
}

function completedHistory(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    {
      type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'stored history' }], source: { kind: 'user' } }),
    },
    { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('history activation ownership', () => {
  it('leaves no live Agents or Sessions after browsing several stored histories', async () => {
    await using harness = await persistentHarness()
    const { ctx, controller } = harness
    const originalResume = ctx.agents.resume.bind(ctx.agents)
    const resumes: ReturnType<typeof originalResume>[] = []
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation((options) => {
      const operation = originalResume(options)
      resumes.push(operation)
      return operation
    })
    const liveCounts: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const id = SessionId(`history-${index}`)
      await harness.seed(id, completedHistory())
      await expect(controller.page({ address: { kind: 'session', sessionId: id }, throughSeq: 2 }, new AbortController().signal))
        .resolves.toMatchObject({ records: [{}, {}, {}], hasMore: false })
      const abort = new AbortController()
      const iterator = controller.follow({ address: { kind: 'session', sessionId: id } }, abort.signal)
        [Symbol.asyncIterator]()
      try {
        await expect(iterator.next()).resolves.toMatchObject({
          value: { type: 'snapshot', cursor: 2, records: [{}, {}, {}] },
        })
        const waiting = iterator.next()
        abort.abort()
        await expect(waiting).resolves.toMatchObject({ done: true })
        await Promise.all(resumes)
        liveCounts.push(ctx.agents.roots().length)
      } finally {
        abort.abort()
        await iterator.return?.()
      }
    }
    expect(liveCounts).toEqual([0, 0, 0])
    expect(ctx.sessions.list()).toEqual([])
    expect(resume).not.toHaveBeenCalled()
    expect(harness.adapter.calls).toBe(0)
  })

  it('resumes on an explicit prompt and follows its contiguous durable events', async () => {
    await using harness = await persistentHarness()
    const { ctx, controller } = harness
    const id = SessionId('continue-history')
    await harness.seed(id, completedHistory())
    const resume = vi.spyOn(ctx.agents, 'resume')
    const abort = new AbortController()
    const iterator = controller.follow({ address: { kind: 'session', sessionId: id } }, abort.signal)
      [Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot', cursor: 2 } })
      const pending = iterator.next()
      await expect(controller.prompt({
        sessionId: id, requestId: 'continue-history' as SessionRequestId,
        mode: 'queue', content: [{ type: 'text', text: 'continue now' }],
      }, abort.signal)).resolves.toEqual({ accepted: true })
      const agent = ctx.agents.get(id)
      expect(agent).toBeDefined()
      if (agent === undefined) throw new Error('prompt did not resume the Agent')
      await agent.whenIdle()
      const delivered: SessionWireEvent[] = []
      let next = await pending
      while (!next.done) {
        if (next.value.type === 'event') {
          delivered.push(next.value.event)
          if (next.value.event.type === 'turn/end') break
        }
        next = await iterator.next()
      }
      expect(delivered.map(event => event.seq)).toEqual(delivered.map((_, index) => index + 3))
      expect(delivered).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'user/message' }),
        expect.objectContaining({ type: 'assistant/message' }),
        expect.objectContaining({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }),
      ]))
      expect(resume).toHaveBeenCalledOnce()
      expect(harness.adapter.calls).toBe(1)
      abort.abort()
      await expect(iterator.next()).resolves.toMatchObject({ done: true })
      expect(ctx.agents.get(id)).toBe(agent)
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('keeps restored queued input cold until an explicit queue mutation', async () => {
    await using harness = await persistentHarness()
    const { ctx, controller } = harness
    const id = SessionId('queued-history')
    const message = createUserMessage({ content: [{ type: 'text', text: 'waiting input' }], source: { kind: 'user' } })
    await harness.seed(id, [{
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    }])
    const resume = vi.spyOn(ctx.agents, 'resume')
    const abort = new AbortController()
    const iterator = controller.follow({ address: { kind: 'session', sessionId: id } }, abort.signal)
      [Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot', cursor: 0 } })
      expect(resume).not.toHaveBeenCalled()
      const pending = iterator.next()
      await expect(controller.updateQueue({ sessionId: id, itemId: message.id, action: { kind: 'remove' } }))
        .resolves.toEqual({ accepted: true })
      await expect(pending).resolves.toMatchObject({
        value: { type: 'event', event: { seq: 1, type: 'session/end-seed' } },
      })
      await expect(iterator.next()).resolves.toMatchObject({
        value: { type: 'event', event: { seq: 2, type: 'agent/inbox/spliced', data: { removedCount: 1, outcome: 'canceled' } } },
      })
      expect(resume).toHaveBeenCalledOnce()
      expect(ctx.agents.get(id)?.inbox.nextTurn).toEqual([])
      expect(harness.adapter.calls).toBe(0)
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it.each(['abort', 'read-failure'] as const)('closes a cold read on %s without activating an Agent', async (outcome) => {
    await using harness = await persistentHarness()
    const { ctx, controller } = harness
    const id = SessionId(`unopened-${outcome}`)
    await harness.seed(id, completedHistory())
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const closed = vi.fn()
    const failure = new Error('fixture read failed')
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      const read = handle.read.bind(handle)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        entered.resolve(undefined)
        await release.promise
        if (outcome === 'read-failure') throw failure
        return read(...readArgs)
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        closed()
      })
      return handle
    })
    const resume = vi.spyOn(ctx.agents, 'resume')
    const abort = new AbortController()
    const iterator = controller.follow({ address: { kind: 'session', sessionId: id } }, abort.signal)
      [Symbol.asyncIterator]()
    const opening = iterator.next()
    const rejected = expect(opening).rejects.toMatchObject({
      code: outcome === 'abort' ? 'SESSION_QUERY_ABORTED' : 'SESSION_QUERY_PERSISTENCE_FAILED',
      ...(outcome === 'read-failure' ? { cause: failure } : {}),
    })
    try {
      await entered.promise
      if (outcome === 'abort') abort.abort()
      release.resolve(undefined)
      await rejected
      expect(closed).toHaveBeenCalledOnce()
      expect(resume).not.toHaveBeenCalled()
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      abort.abort()
      release.resolve(undefined)
      await Promise.allSettled([opening])
      await iterator.return?.()
    }
  })
})
