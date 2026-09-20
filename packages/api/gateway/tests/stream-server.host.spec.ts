import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  RemoteStreamMuxServer,
  type RemoteStreamFailureMapper,
  type RemoteStreamOpener,
} from '../src/stream-server.ts'

interface RunningMux {
  readonly http: Server
  readonly mux: RemoteStreamMuxServer
  readonly url: string
}

const running = new Set<RunningMux>()
const clients = new Set<WebSocket>()

afterEach(async () => {
  await Promise.all([...clients].map(async (socket) => {
    clients.delete(socket)
    if (socket.readyState === WebSocket.CLOSED) return
    const closed = once(socket, 'close')
    socket.terminate()
    await closed
  }))
  await Promise.all([...running].map(async (entry) => {
    running.delete(entry)
    await entry.mux.close().catch(() => undefined)
    await closeHttp(entry.http)
  }))
})

describe('Remote stream mux server carrier lifecycle', () => {
  it('compresses a tool-heavy history snapshot without changing its JSON', async () => {
    const value = historySnapshot()
    const entry = await startMux(async () => oneItem(value), 60_000)
    const client = new WebSocket(entry.url)
    clients.add(client)
    const upgrade = once(client, 'upgrade')
    await once(client, 'open')
    const [response] = await upgrade as [IncomingMessage]
    expect(response.headers['sec-websocket-extensions']).toBe(
      'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
    )
    const carrier = (client as unknown as { _socket: Socket })._socket
    const before = carrier.bytesRead
    const received = receiveFrames(client)
    client.send(openFrame('history'))
    const frames = await received
    const jsonBytes = Buffer.byteLength(JSON.stringify({ type: 'item', streamId: 'history', value }))
    const wireBytes = carrier.bytesRead - before

    expect(frames).toEqual([
      { type: 'item', streamId: 'history', value },
      { type: 'end', streamId: 'history' },
    ])
    expect(jsonBytes).toBeGreaterThan(1_000_000)
    expect(wireBytes).toBeLessThan(jsonBytes / 2)
  })

  it.each([
    { serverCompression: false, clientCompression: true },
    { serverCompression: true, clientCompression: false },
  ])('preserves history when compression is not negotiated: %j', async ({ serverCompression, clientCompression }) => {
    const value = historySnapshot()
    const entry = await startMux(async () => oneItem(value), 60_000, serverCompression)
    const client = await connect(entry.url, true, clientCompression)
    expect(client.extensions).toBe('')
    const carrier = (client as unknown as { _socket: Socket })._socket
    const before = carrier.bytesRead
    const received = receiveFrames(client)
    client.send(openFrame('history'))
    expect(await received).toEqual([
      { type: 'item', streamId: 'history', value },
      { type: 'end', streamId: 'history' },
    ])
    expect(carrier.bytesRead - before).toBeGreaterThan(Buffer.byteLength(JSON.stringify(value)))
  })

  it('leaves small application frames uncompressed on a compressed socket', async () => {
    const entry = await startMux(async () => oneItem('ready'), 60_000)
    const client = await connect(entry.url)
    expect(client.extensions).toBe('permessage-deflate')
    const carrier = (client as unknown as { _socket: Socket })._socket
    const before = carrier.bytesRead
    const received = receiveFrames(client)
    client.send(openFrame('small'))
    const frames = await received
    expect(frames).toEqual([
      { type: 'item', streamId: 'small', value: 'ready' },
      { type: 'end', streamId: 'small' },
    ])
    const frameBytes = frames.reduce<number>((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)) + 2, 0)
    expect(carrier.bytesRead - before).toBe(frameBytes)
  })

  it('sends WebSocket Ping control frames without application messages', async () => {
    const entry = await startMux(async (_endpoint, _payload, signal) => waitForAbort(signal), 20)
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    const messages = vi.fn()
    client.on('message', messages)

    const ping = once(client, 'ping')
    const pong = once(serverSocket, 'pong')
    expect((await ping)[0]).toEqual(Buffer.alloc(0))
    expect((await pong)[0]).toEqual(Buffer.alloc(0))
    expect(messages).not.toHaveBeenCalled()

    const closingPing = vi.spyOn(serverSocket, 'ping')
    client.pause()
    serverSocket.close()
    expect(serverSocket.readyState).toBe(WebSocket.CLOSING)
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
    expect(closingPing).not.toHaveBeenCalled()

    const closed = once(client, 'close')
    client.resume()
    await closed
  })

  it('requires two missed heartbeats before terminating an unresponsive socket', async () => {
    const entry = await startMux(async (_endpoint, _payload, signal) => waitForAbort(signal), 20)
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    serverSocket.removeAllListeners('pong')
    const terminated = vi.spyOn(serverSocket, 'terminate')
    const closed = once(client, 'close')

    await once(client, 'ping')
    await once(client, 'ping')
    expect(terminated).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(terminated).toHaveBeenCalledOnce() })
    await closed
  })

  it('keeps the socket when a delayed Pong arrives before the final check', async () => {
    const entry = await startMux(async (_endpoint, _payload, signal) => waitForAbort(signal), 20)
    const client = await connect(entry.url, false)
    const serverSocket = acceptedSocket(entry.mux)
    const terminated = vi.spyOn(serverSocket, 'terminate')
    let finalCheck: (() => void) | undefined
    const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
      finalCheck = callback
      return 0 as unknown as NodeJS.Immediate
    })

    try {
      await once(client, 'ping')
      await once(client, 'ping')
      await vi.waitFor(() => { expect(finalCheck).toBeDefined() })
      serverSocket.emit('pong', Buffer.alloc(0))
      finalCheck?.()
      expect(terminated).not.toHaveBeenCalled()
    } finally {
      immediate.mockRestore()
      const closed = once(client, 'close')
      client.close()
      await closed
    }
  })

  it('rejects binary, malformed, and duplicate logical-stream messages', async () => {
    const entry = await startMux(async (_endpoint, _payload, signal) => waitForAbort(signal))

    const binary = await connect(entry.url)
    const binaryClosed = once(binary, 'close')
    binary.send(Buffer.from('{}'))
    const binaryEvent = await binaryClosed
    expect(binaryEvent[0]).toBe(1003)

    const malformed = await connect(entry.url)
    const malformedClosed = once(malformed, 'close')
    malformed.send('not json')
    const malformedEvent = await malformedClosed
    expect(malformedEvent[0]).toBe(1008)
    expect(String(malformedEvent[1])).toBe('invalid Remote stream request')

    const duplicate = await connect(entry.url)
    const longId = 'same'.repeat(100)
    duplicate.send(openFrame(longId))
    duplicate.send(openFrame(longId))
    const duplicateEvent = await once(duplicate, 'close')
    expect(duplicateEvent[0]).toBe(1008)
    expect(String(duplicateEvent[1])).toBe('invalid Remote stream request')

    const noInput = await connect(entry.url)
    noInput.send(openFrame('no-input'))
    noInput.send(JSON.stringify({ type: 'input', streamId: 'no-input', value: 'unexpected' }))
    const noInputEvent = await once(noInput, 'close')
    expect(noInputEvent[0]).toBe(1008)
    expect(String(noInputEvent[1])).toBe('invalid Remote stream request')
  })

  it('accepts all ws text representations and terminates a carrier error', async () => {
    const entry = await startMux(async (_endpoint, _payload, signal) => waitForAbort(signal))
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    const cancel = JSON.stringify({ type: 'cancel', streamId: 'absent' })

    serverSocket.emit('message', [Buffer.from(cancel)], false)
    serverSocket.emit('message', Uint8Array.from(Buffer.from(cancel)).buffer, false)

    const closed = once(client, 'close')
    serverSocket.emit('error', new Error('fixture carrier failure'))
    await closed
  })

  it('does not send an end frame after clean source cancellation', async () => {
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async (_endpoint, _payload, signal) => {
      opened()
      return cleanlyCancelled(signal, returned)
    })
    const client = await connect(entry.url)
    const frames: unknown[] = []
    client.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
      frames.push(JSON.parse(data.toString('utf8')) as unknown)
    })
    client.send(openFrame('cancelled'))
    await didOpen
    client.send(JSON.stringify({ type: 'cancel', streamId: 'cancelled' }))
    await didReturn
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(frames).toEqual([])
    client.close()
    await once(client, 'close')
  })

  it('closes the carrier when ws reports an item write failure', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    const entry = await startMux(async () => delayedItem(released, opened))
    const client = await connect(entry.url)
    client.send(openFrame('write-failure'))
    await didOpen
    const serverSocket = acceptedSocket(entry.mux)
    const mutable = serverSocket as unknown as {
      send(data: unknown, callback: (error?: Error) => void): void
    }
    mutable.send = (_data, callback): void => {
      callback(new Error('fixture ws write failure'))
    }

    const closed = once(client, 'close')
    release()
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
  })

  it('contains an item produced after its socket closes', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async () => delayedItem(released, opened, returned))
    const client = await connect(entry.url)
    client.send(openFrame('late-item'))
    await didOpen
    const serverSocket = acceptedSocket(entry.mux)
    client.close()
    await once(client, 'close')
    await vi.waitFor(() => { expect(serverSocket.readyState).toBe(WebSocket.CLOSED) })
    release()
    await didReturn
  })

  it('terminates active sockets on close and reports a repeated close', async () => {
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async (_endpoint, _payload, signal) => {
      opened()
      return cleanlyCancelled(signal, returned)
    })
    const client = await connect(entry.url)
    client.send(openFrame('active'))
    await didOpen

    const closed = once(client, 'close')
    await entry.mux.close()
    running.delete(entry)
    await closed
    await didReturn
    await expect(entry.mux.close()).rejects.toThrow()
    await closeHttp(entry.http)
  })
})

const mapFailure: RemoteStreamFailureMapper = error => ({
  code: 'internal',
  message: error instanceof Error ? error.message : String(error),
  details: {},
})

async function startMux(open: RemoteStreamOpener, heartbeatIntervalMs = 2_000, websocketCompression = true): Promise<RunningMux> {
  const mux = new RemoteStreamMuxServer(open, mapFailure, heartbeatIntervalMs, websocketCompression)
  const http = createServer()
  http.on('upgrade', (request, socket, head) => { mux.handleUpgrade(request, socket, head) })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('fixture HTTP server has no TCP port')
  const entry = { http, mux, url: `ws://127.0.0.1:${String(address.port)}` }
  running.add(entry)
  return entry
}

async function connect(url: string, autoPong = true, perMessageDeflate = true): Promise<WebSocket> {
  const socket = new WebSocket(url, { autoPong, perMessageDeflate })
  clients.add(socket)
  await once(socket, 'open')
  return socket
}

function acceptedSocket(mux: RemoteStreamMuxServer): WebSocket {
  const exposed = mux as unknown as { server: { clients: Set<WebSocket> } }
  const socket = [...exposed.server.clients][0]
  if (socket === undefined) throw new Error('fixture mux has no accepted socket')
  return socket
}

function openFrame(streamId: string): string {
  return JSON.stringify({ type: 'open', streamId, endpoint: 'fixture/follow', payload: {} })
}

function historySnapshot(): unknown {
  const words = 'fixture history browser request response stream plugin configuration result value message cursor sequence rendering memory token compact source timing output tool arguments schema description parameter context runtime storage page session'.split(' ')
  let seed = 0x73a5f491
  const prose = (count: number): string => Array.from({ length: count }, () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    return words[(seed >>> 16) % words.length]
  }).join(' ')
  const tools = Array.from({ length: 12 }, (_, index) => ({
    name: `fixture_tool_${String(index)}`,
    description: prose(60),
    parameters: { type: 'object', properties: { input: { type: 'string', description: prose(40) } } },
  }))
  const events = Array.from({ length: 50 }, (_, turn) => [
    { type: 'request/header', turn, system: prose(120), tools },
    { type: 'assistant/message', turn, stream: Array.from({ length: 160 }, (_, time) => [time * 10, prose(5)]) },
    { type: 'tool/call', turn, name: `fixture_tool_${String(turn % tools.length)}`, arguments: { input: prose(60) } },
    { type: 'tool/result', turn, result: Array.from({ length: 35 }, (_, row) => ({ row, content: prose(30) })) },
    { type: 'assistant/message', turn, content: prose(140) },
  ]).flat()
  return { type: 'snapshot', cursor: 18_000, events }
}

async function *oneItem(value: unknown): AsyncIterable<unknown> {
  yield value
}

function receiveFrames(socket: WebSocket): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const frames: unknown[] = []
    const cleanup = (): void => {
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('message', onMessage)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => { onError(new Error('fixture stream closed before its end frame')) }
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
        const frame = JSON.parse(data.toString('utf8')) as { type: string }
        frames.push(frame)
        if (frame.type !== 'end') return
        cleanup()
        resolve(frames)
      } catch (error) {
        cleanup()
        reject(new Error('fixture stream message was invalid', { cause: error }))
      }
    }
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.on('message', onMessage)
  })
}

async function *waitForAbort(signal: AbortSignal): AsyncIterable<never> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function *cleanlyCancelled(signal: AbortSignal, returned: () => void): AsyncIterable<never> {
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  } finally {
    returned()
  }
}

async function *delayedItem(
  released: Promise<void>,
  opened: () => void,
  returned: () => void = () => {},
): AsyncIterable<string> {
  try {
    opened()
    await released
    yield 'item'
  } finally {
    returned()
  }
}

async function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}
