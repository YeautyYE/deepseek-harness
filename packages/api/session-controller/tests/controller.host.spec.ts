import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

describe('SessionController facade', () => {
  it('does not require the Tools service', () => {
    expect(SessionController.inject).not.toContain('tools')
  })

  it('owns Host service methods and publishes Agent lifecycle projections', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('controller-session')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const events: SessionEvent[] = []
    const inspect = vi.fn(() => Promise.resolve({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect,
    }) as never)
    let uploadResolver: ((sessionId: SessionId) => Promise<Agent>) | undefined
    ctx.provide('fileUploads', {
      registerAgentResolver: (resolve: (sessionId: SessionId) => Promise<Agent>) => {
        uploadResolver = resolve
        return () => {}
      },
      resolve: () => undefined,
      bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
      retirePrompt: () => {},
    } as never)
    const controller = createSessionTestController(ctx, defaults)
    const status = vi.fn()
    const failure = vi.fn()
    const activity = vi.fn()
    ctx.on('api-session/status', status)
    ctx.on('api-session/error', failure)
    ctx.on('api-session/activity', activity)

    await expect(controller.inspect(sessionId)).resolves.toEqual({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    })
    expect(inspect).toHaveBeenCalledOnce()

    const session = ctx.sessions.create(sessionId, { meta: header })
    const agent = {
      id: sessionId,
      session,
      status: 'idle',
      ctx,
    } as Agent
    await ctx.agents.register(agent)
    const resolveUploadAgent = (id: SessionId): Promise<Agent> => {
      if (uploadResolver === undefined) throw new Error('file upload resolver was not registered')
      return uploadResolver(id)
    }
    await expect(resolveUploadAgent(sessionId)).resolves.toBe(agent)
    const activationError = new RemoteError('session/not-found', 'missing upload session', { sessionId })
    vi.spyOn(
      (controller as unknown as { agents: ApiSessionAgentController }).agents,
      'resolveAgent',
    ).mockResolvedValueOnce({ error: activationError })
    await expect(resolveUploadAgent(sessionId)).rejects.toBe(activationError)
    const consumeSelection = vi.spyOn(
      (controller as unknown as { agents: ApiSessionAgentController }).agents,
      'consumeSelection',
    )

    await expect(controller.resolveAgent(sessionId)).resolves.toEqual({ agent })
    await expect(controller.inspect(sessionId)).resolves.toEqual({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    })
    expect(inspect).toHaveBeenCalledOnce()
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('fixture failure') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'browser prompt' }],
      source: { kind: 'user', rpcId: 'controller-rpc' as never },
    }), { surfaceOp: 'append' })
    expect(status).toHaveBeenCalledWith(sessionId, true)
    expect(failure).toHaveBeenCalledWith(sessionId, expect.stringContaining('fixture failure'))
    expect(activity).toHaveBeenCalledWith(sessionId, expect.any(Number))
    session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture-model' } },
      reason: 'initial',
    })
    expect(consumeSelection).toHaveBeenCalledWith(
      agent, 'fixture', 'fixture-model', undefined,
    )
    const unowned = ctx.sessions.create(SessionId('controller-unowned'), {
      meta: { cwd: '/workspace' },
    })
    unowned.append('request/header', {
      header: { config: { provider: 'fixture', model: 'other-model' } },
      reason: 'initial',
    })
    expect(consumeSelection).toHaveBeenCalledTimes(1)

    const abort = new AbortController()
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: 2 },
    })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

})
