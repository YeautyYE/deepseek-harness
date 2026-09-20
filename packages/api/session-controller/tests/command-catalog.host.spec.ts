/** Command discovery reads cold preset scopes; execution retains explicit Agent ownership. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController } from './test-remote.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const commandsFiber = await ctx.plugin(Commands)
  const controller = createSessionTestController(ctx, {
    cwd: '/fixture', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
  })
  const id = SessionId('catalog-session')
  const observed: SessionObservation = {
    source: 'prepared',
    header: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/fixture' },
    inheritedEventCount: SessionLogOffset(0), events: [], cursor: -1,
    projections: { asOfSeq: -1, values: { agentPreset: 'saved-preset' } },
    retain: vi.fn(), [Symbol.dispose]: vi.fn(),
  }
  const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockResolvedValue(observed)
  const resume = vi.spyOn(ctx.agents, 'resume')
  return { ctx, controller, id, observe, resume, observed, commandsFiber, [Symbol.asyncDispose]: () => ctx.fiber.dispose() }
}

describe('Session command catalog', () => {
  it('lists global and recorded-preset commands without resuming a cold Agent', async () => {
    await using h = await harness()
    const { ctx, id, controller } = h
    const presetKey = { preset: 'saved-preset' }
    const standing = createScope(ctx, presetKey)
    ctx.commands.register({ name: 'global', description: 'global', handler: () => ({ kind: 'success' }) })
    standing.ctx.get('commands')!.register({ name: 'plan', description: 'preset', handler: () => ({ kind: 'success' }) })
    const standingKeyFor = vi.fn(() => Promise.resolve(presetKey))
    ctx.provide('agentPresets', { standingKeyFor } as never)
    const signal = new AbortController().signal

    await expect(controller.commandCatalog(id, signal)).resolves.toEqual([
      { name: 'global', description: 'global' }, { name: 'plan', description: 'preset' },
    ])
    expect(standingKeyFor).toHaveBeenCalledWith('saved-preset')
    expect(h.observe).toHaveBeenCalledWith(id, { signal })
    expect(h.observed[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(h.resume).not.toHaveBeenCalled()
    expect(ctx.sessions.list()).toEqual([])
  })

  it('uses the global catalog when no preset service is composed', async () => {
    await using h = await harness()
    h.ctx.commands.register({ name: 'global', description: 'global', handler: () => ({ kind: 'success' }) })
    await expect(h.controller.commandCatalog(h.id, new AbortController().signal))
      .resolves.toEqual([{ name: 'global', description: 'global' }])
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('selects the default standing preset for history without a recorded preset', async () => {
    await using h = await harness()
    h.observe.mockResolvedValue({ ...h.observed, projections: { asOfSeq: -1, values: {} } })
    const standingKeyFor = vi.fn(() => Promise.resolve({ preset: 'default' }))
    h.ctx.provide('agentPresets', { standingKeyFor } as never)
    await expect(h.controller.commandCatalog(h.id, new AbortController().signal)).resolves.toEqual([])
    expect(standingKeyFor).toHaveBeenCalledWith(undefined)
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('uses an attached Agent scope without reading persistence and rejects live child ownership', async () => {
    await using h = await harness()
    const session = h.ctx.sessions.create(h.id, { meta: { cwd: '/fixture' } })
    const agent = { id: h.id, session, ctx: h.ctx, status: 'idle' } as Agent
    await h.ctx.agents.register(agent)
    const scope = createScope(h.ctx, agent)
    scope.ctx.get('commands')!.register({ name: 'live', description: 'live', handler: () => ({ kind: 'success' }) })
    await expect(h.controller.commandCatalog(h.id, new AbortController().signal))
      .resolves.toEqual([{ name: 'live', description: 'live' }])
    expect(h.observe).not.toHaveBeenCalled()
    const childSession = h.ctx.sessions.create(SessionId('child'), { meta: { cwd: '/fixture', origin: 'subagent' } })
    await h.ctx.agents.register({ id: childSession.id, session: childSession, ctx: h.ctx, status: 'idle' } as Agent)
    await expect(h.controller.commandCatalog(childSession.id, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/agent-busy' })
  })

  it.each(['missing', 'cwd', 'child', 'projection', 'read'] as const)('rejects %s without activating an Agent', async (kind) => {
    await using h = await harness()
    switch (kind) {
      case 'missing': h.observe.mockRejectedValue(new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')); break
      case 'cwd': {
        const { cwd, ...header } = h.observed.header
        void cwd
        h.observe.mockResolvedValue({ ...h.observed, header })
        break
      }
      case 'child': h.observe.mockResolvedValue({ ...h.observed, header: { ...h.observed.header, origin: 'subagent' } }); break
      case 'projection': {
        const { projections, ...observed } = h.observed
        void projections
        h.observe.mockResolvedValue(observed)
        break
      }
      case 'read': h.observe.mockRejectedValue(new Error('read failed')); break
    }
    const result = h.controller.commandCatalog(h.id, new AbortController().signal)
    if (kind === 'missing' || kind === 'cwd') await expect(result).rejects.toMatchObject({ code: 'session/not-found' })
    else if (kind === 'child') await expect(result).rejects.toMatchObject({ code: 'session/agent-busy' })
    else await expect(result).rejects.toThrow(kind === 'projection' ? 'projected Session observation' : 'read failed')
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('rejects cancellation after standing preset readiness without publishing a catalog', async () => {
    await using h = await harness()
    const abort = new AbortController()
    h.ctx.provide('agentPresets', { standingKeyFor: () => { abort.abort(new Error('cancelled catalog')); return Promise.resolve({}) } } as never)
    await expect(h.controller.commandCatalog(h.id, abort.signal)).rejects.toThrow('cancelled catalog')
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('reports a missing registry before starting a cold read', async () => {
    await using h = await harness()
    await h.commandsFiber.dispose()
    await expect(h.controller.commandCatalog(h.id, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway/internal' })
    expect(h.observe).not.toHaveBeenCalled()
  })
})
