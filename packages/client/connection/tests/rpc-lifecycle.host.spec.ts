/** Dedicated RPC channels own their injected carrier and caller lifetime. */
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, type HostConnectionHandle } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

class RouteServer extends Service {
  constructor(ctx: Context, private readonly routes: Map<string, WebRoute>) {
    super(ctx, 'webServer')
  }

  register(route: WebRoute): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }
}

describe('dedicated RPC carrier lifecycle', () => {
  const fibers: Fiber[] = []

  afterEach(async () => {
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  })

  async function connection(): Promise<Context> {
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    fibers.push(fiber)
    await fiber.await()
    return ctx
  }

  async function server(ctx: Context): Promise<{ fiber: Fiber; routes: Map<string, WebRoute> }> {
    const routes = new Map<string, WebRoute>()
    const fiber = ctx.plugin((webCtx) => { new RouteServer(webCtx, routes) })
    fibers.push(fiber)
    await fiber.await()
    return { fiber, routes }
  }

  async function consumer(ctx: Context): Promise<{ fiber: Fiber; remove: () => Promise<void> }> {
    let remove: (() => Promise<void>) | undefined
    const fiber = ctx.plugin({
      inject: ['connection'],
      apply(clientCtx: Context) {
        remove = clientCtx.connection.rpc.handle('/fixture-rpc', async () => ({ ok: true, value: null }))
      },
    })
    fibers.push(fiber)
    await fiber.await()
    expect(remove).toBeDefined()
    return { fiber, remove: remove! }
  }

  it('mounts for a consumer injecting only Connection and removes its caller-owned route', async () => {
    const ctx = await connection()
    const web = await server(ctx)
    const caller = await consumer(ctx)
    await vi.waitFor(() => { expect(web.routes.has('/fixture-rpc')).toBe(true) })
    await caller.fiber.dispose()
    expect(web.routes.has('/fixture-rpc')).toBe(false)
    expect(web.routes.has('/api')).toBe(true)
  })

  it('waits for the Web carrier and remounts on its replacement', async () => {
    const ctx = await connection()
    const caller = await consumer(ctx)
    const first = await server(ctx)
    await vi.waitFor(() => { expect(first.routes.has('/fixture-rpc')).toBe(true) })
    await first.fiber.dispose()
    expect(first.routes.size).toBe(0)
    const replacement = await server(ctx)
    await vi.waitFor(() => { expect(replacement.routes.has('/fixture-rpc')).toBe(true) })
    await caller.remove()
    expect(replacement.routes.has('/fixture-rpc')).toBe(false)
    expect(replacement.routes.has('/api')).toBe(true)
  })

  it('disposing a pending channel prevents a late carrier from mounting it', async () => {
    const ctx = await connection()
    const caller = await consumer(ctx)
    await caller.remove()
    const web = await server(ctx)
    await vi.waitFor(() => { expect(web.routes.has('/api')).toBe(true) })
    expect(web.routes.has('/fixture-rpc')).toBe(false)
  })

  it('claims pending channel names until disposal completes', async () => {
    const ctx = await connection()
    const connectionService = ctx.get('connection') as HostConnectionHandle
    const first = connectionService.rpc.handle('/fixture-rpc', async () => ({ ok: true, value: null }))
    expect(() => connectionService.rpc.handle('/fixture-rpc', async () => ({ ok: true, value: null })))
      .toThrow('duplicate route')
    await first()
    const second = connectionService.rpc.handle('/fixture-rpc', async () => ({ ok: true, value: null }))
    const web = await server(ctx)
    await vi.waitFor(() => { expect(web.routes.has('/fixture-rpc')).toBe(true) })
    await second()
    expect(web.routes.has('/fixture-rpc')).toBe(false)
  })
})
