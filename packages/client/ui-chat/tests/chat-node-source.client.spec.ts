import { describe, expect, it, vi } from 'vitest'
import type {
  ChatConversationViewNode, ChatNodeSource,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

const timeline: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }

function userNode(index: number, text = `message ${String(index)}`): ChatConversationViewNode {
  return {
    key: `user:${String(index)}`,
    id: String(index),
    target: 'chat',
    kind: 'user',
    anchorSeq: index,
    location: { kind: 'session' },
    visibility: 'visible',
    data: {
      kind: 'user',
      messageId: `message-${String(index)}`,
      seq: index,
      time: index,
      content: [{ type: 'text', text }],
      source: null,
    },
  }
}

describe('Chat Node keyed sources', () => {
  it('notifies only the updated key among 4,000 mounted sources', () => {
    const builder = new ChatSnapshotBuilder()
    const nodes = Array.from({ length: 4_000 }, (_, index) => userNode(index + 1))
    const initial = builder.replace({ nodes, timeline })
    const listeners = nodes.map(() => vi.fn())
    const sources: ChatNodeSource[] = nodes.map((node, index) => {
      const source = initial.nodes.source(node.key)
      source.subscribe(listeners[index]!)
      return source
    })

    const target = 2_347
    const changed = userNode(target + 1, 'streamed update')
    const next = builder.apply({ upserts: [changed], timeline })

    expect(listeners[target]).toHaveBeenCalledOnce()
    expect(listeners.reduce((count, listener) => count + listener.mock.calls.length, 0)).toBe(1)
    expect(next.nodes.source(changed.key)).toBe(sources[target])
    expect(next.nodes.get(changed.key)).toBe(changed)
  })

  it('keeps held sources connected across window replacement and reappearance', () => {
    const builder = new ChatSnapshotBuilder()
    const first = userNode(1)
    const initial = builder.replace({ nodes: [first], timeline })
    const source = initial.nodes.source(first.key)
    const processSource = initial.nodes.processSource(first.key)
    const nodeListener = vi.fn()
    const processListener = vi.fn()
    const stopNode = source.subscribe(nodeListener)
    const stopProcess = processSource.subscribe(processListener)

    const next = builder.replace({ nodes: [], timeline })

    expect(nodeListener).toHaveBeenCalledOnce()
    expect(processListener).not.toHaveBeenCalled()
    expect(source.getSnapshot()).toBeUndefined()
    expect(processSource.getSnapshot()).toBeUndefined()
    expect(next.nodes.source(first.key)).toBe(source)
    expect(next.nodes.processSource(first.key)).toBe(processSource)

    const returned = userNode(1, 'returned')
    builder.apply({ upserts: [returned], timeline })
    expect(source.getSnapshot()).toBe(returned)
    expect(nodeListener).toHaveBeenCalledTimes(2)
    stopNode()
    stopProcess()
    builder.apply({ upserts: [userNode(1, 'unobserved')], timeline })
    expect(nodeListener).toHaveBeenCalledTimes(2)
    expect(next.nodes.source(first.key)).toBe(source)
  })

  it('allows unobserved sources to be collected without removing their replacement', () => {
    const references: { value: object | undefined }[] = []
    const registries: {
      readonly collect: (held: unknown) => void
      readonly held: unknown[]
    }[] = []
    // Collection timing is controlled here; real GC is not a CI synchronization primitive.
    vi.stubGlobal('WeakRef', class {
      readonly reference: { value: object | undefined }
      constructor(value: object) { this.reference = { value }; references.push(this.reference) }
      deref(): object | undefined { return this.reference.value }
    })
    vi.stubGlobal('FinalizationRegistry', class {
      readonly held: unknown[] = []
      constructor(collect: (held: unknown) => void) { registries.push({ collect, held: this.held }) }
      register(_target: object, held: unknown): void { this.held.push(held) }
    })
    try {
      const builder = new ChatSnapshotBuilder()
      const first = userNode(1)
      const store = builder.replace({ nodes: [first], timeline }).nodes
      const old = store.source(first.key)
      const oldProcess = store.processSource(first.key)
      expect(references).toHaveLength(2)
      builder.replace({ nodes: [], timeline })
      references[0]!.value = undefined
      references[1]!.value = undefined
      builder.apply({ upserts: [first], timeline })
      const replacement = store.source(first.key)
      const replacementProcess = store.processSource(first.key)
      expect(replacement).not.toBe(old)
      expect(replacementProcess).not.toBe(oldProcess)
      for (const registry of registries) registry.collect(registry.held[0])
      expect(store.source(first.key)).toBe(replacement)
      expect(store.processSource(first.key)).toBe(replacementProcess)
      references[2]!.value = undefined
      references[3]!.value = undefined
      for (const registry of registries) registry.collect(registry.held[1])
      expect(store.source(first.key)).not.toBe(replacement)
      expect(store.processSource(first.key)).not.toBe(replacementProcess)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
