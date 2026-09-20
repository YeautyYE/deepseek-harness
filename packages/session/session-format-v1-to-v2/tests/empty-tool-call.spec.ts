/** Released empty Tool ids have deterministic, fully paired migration semantics. */

import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import { assertReleasedPayloadSemantics } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { describe, expect, it } from 'vitest'
import { ReleasedEmptyToolCallRepair } from '../src/empty-tool-call.ts'
import { assertReleasedV2Artifact } from '../src/testing/validation.ts'

type MutableRecord = Record<string, SessionFormatJsonValue>
type MutableEvent = { -readonly [Key in keyof SessionFormatEvent]: SessionFormatEvent[Key] }

function fixture(turn = 1, offset = 0, id = ''): SessionFormatEvent[] {
  const block = { type: 'tool-call', id, name: '', arguments: '{}' }
  const at = (type: string, seq: number, data: SessionFormatJsonObject): SessionFormatEvent => ({
    type, seq: seq + offset, time: seq + offset + 1, data: { turn, step: 1, ...data },
  })
  const chunk = (seq: number, chunk: SessionFormatJsonObject) => at('assistant/chunk', seq, { chunk })
  return [
    at('turn/start', 0, { turn }),
    at('step/start', 1, {}),
    chunk(2, { type: 'block-start', index: 9, blockType: 'text' }),
    chunk(3, { type: 'text-delta', index: 9, text: 'context' }),
    chunk(4, { type: 'block-end', index: 9, block: { type: 'text', text: 'context' } }),
    chunk(5, { type: 'block-start', index: 17, blockType: 'tool-call' }),
    chunk(6, { type: 'tool-call-delta', index: 17, id, name: '', argumentsDelta: '{}' }),
    chunk(7, { type: 'block-end', index: 17, block }),
    chunk(8, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }),
    chunk(9, { type: 'finish', reason: { kind: 'tool-calls' } }),
    { ...at('assistant/message', 10, { usage: { inputTokens: 1, outputTokens: 2 }, message: {
      id: `message-${turn}`, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: [{ type: 'text', text: 'context' }, block],
    } }), sourceEventSeqs: Array.from({ length: 8 }, (_, index) => index + offset + 2), surfaceOp: 'append' },
    at('tool/call', 11, { callId: id, name: '', arguments: '{}' }),
    { ...at('tool/result', 12, { message: {
      id: `result-${turn}`, role: 'user', source: { kind: 'tool', callId: id },
      content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: 'Unknown tool' }], isError: true }],
    } }), surfaceOp: 'append', sourceEventSeqs: [offset + 11] },
    at('step/end', 13, {}),
    { type: 'turn/end', seq: offset + 14, time: offset + 15, data: { turn, reason: { kind: 'completed' } } },
  ].map(event => event.type === 'turn/start' ? { ...event, data: { turn } } : event)
}

function migrate(events: readonly SessionFormatEvent[]) {
  const sourceHeader = { version: 1, id: 'empty-tool-id', createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const targetHeader = sessionFormatV1ToV2.migrateHeader(sourceHeader)
  const stage = sessionFormatV1ToV2.createStage({ sourceHeader, targetHeader, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
  const collector = new SessionFormatEventCollector()
  for (const event of events) stage.transformEvent(event, collector)
  const inheritedEventCount = stage.finish(collector)
  const artifact = { header: targetHeader, inheritedEventCount, events: collector.values }
  assertReleasedV2Artifact(artifact)
  return artifact.events
}

function data(event: SessionFormatEvent): MutableRecord {
  return event.data as MutableRecord
}

function embeddedFixture() {
  const source = fixture()
  const event = structuredClone(source[10] as SessionFormatEvent)
  data(event)['stream'] = source.slice(2, 10).map(row => ({ type: 'chunk', time: row.time, chunk: data(row)['chunk'] as SessionFormatJsonObject }))
  return event
}

function content(event: SessionFormatEvent): MutableRecord[] {
  return (data(event)['message'] as SessionFormatJsonObject)['content'] as MutableRecord[]
}

function stream(event: SessionFormatEvent): SessionFormatJsonObject[] {
  return data(event)['stream'] as SessionFormatJsonObject[]
}

describe('released empty Tool-call ids', () => {
  it.each([10, 11, 12])('admits released empty ids but rejects unmapped current ids at event %i', (index) => {
    const event = fixture()[index] as SessionFormatEvent
    expect(() => { assertReleasedPayloadSemantics(event, 0) }).not.toThrow()
    expect(() => { assertReleasedPayloadSemantics(event, 1) }).not.toThrow()
    expect(() => { assertReleasedPayloadSemantics(event, 2) }).toThrow(/must be a non-empty string/)
  })

  it('pairs repeated empty ids across turns and preserves ordinary ids', () => {
    const source = [...fixture(), ...fixture(2, 15), ...fixture(3, 30, 'ordinary-call')]
    const before = structuredClone(source)
    const migrated = migrate(source)
    const ids = migrated.filter(event => event.type === 'tool/call').map(event => data(event)['callId'] as string)
    expect(ids).toEqual(['released-v1-tool-1-1-10-1', 'released-v1-tool-2-1-25-1', 'ordinary-call'])
    expect(migrate(source)).toEqual(migrated)
    expect(source).toEqual(before)
    for (const [index, event] of migrated.filter(event => event.type === 'assistant/message').entries()) {
      expect(content(event)[1]?.['id']).toBe(ids[index])
      expect(stream(event).filter(row => row['type'] === 'chunk').map(row => row['chunk']) as unknown[])
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'tool-call-delta', index: 17, id: ids[index] }),
          expect.objectContaining({ type: 'block-end', index: 17, block: expect.objectContaining({ id: ids[index] }) as unknown }),
        ]))
    }
    for (const [index, event] of migrated.filter(event => event.type === 'tool/result').entries()) {
      expect((data(event)['message'] as SessionFormatJsonObject)['source']).toEqual({ kind: 'tool', callId: ids[index] })
      expect(content(event)[0]?.['toolCallId']).toBe(ids[index])
    }
  })

  it.each(['end-of-file', 'step/end', 'turn/end'] as const)('rejects a missing result at %s', (closing) => {
    const events = fixture().slice(0, 12)
    if (closing !== 'end-of-file') events.push({ type: closing, seq: 12, time: 13, data: closing === 'step/end' ? { turn: 1, step: 1 } : { turn: 1, reason: { kind: 'completed' } } })
    expect(() => migrate(events)).toThrow(/no matching result/)
  })

  it.each(['missing', 'wrong-turn', 'wrong-step'] as const)('rejects %s invocation pairing', (kind) => {
    const repair = new ReleasedEmptyToolCallRepair()
    if (kind !== 'missing') repair.transform(embeddedFixture())
    const call = fixture()[11] as SessionFormatEvent
    if (kind === 'wrong-turn') data(call)['turn'] = 2
    if (kind === 'wrong-step') data(call)['step'] = 2
    expect(() => repair.transform(call)).toThrow(/no advertised invocation/)
  })

  it.each(['duplicate', 'name', 'arguments'] as const)('rejects %s invocation', (kind) => {
    const repair = new ReleasedEmptyToolCallRepair()
    repair.transform(embeddedFixture())
    const call = fixture()[11] as SessionFormatEvent
    if (kind === 'duplicate') repair.transform(call)
    else data(call)[kind] = 'different'
    expect(() => repair.transform(call)).toThrow(/advertised name and arguments/)
  })

  it.each(['not-started', 'replacement', 'length', 'block-type', 'result-id'] as const)('rejects %s result', (kind) => {
    const repair = new ReleasedEmptyToolCallRepair()
    repair.transform(embeddedFixture())
    if (kind !== 'not-started') repair.transform(fixture()[11] as SessionFormatEvent)
    const result = fixture()[12] as MutableEvent
    if (kind === 'replacement') result.surfaceOp = { op: 'replace', start: 1, end: 1 }
    if (kind === 'length') content(result).push({ type: 'text', text: 'extra' })
    if (kind === 'block-type') content(result)[0]!['type'] = 'text'
    if (kind === 'result-id') content(result)[0]!['toolCallId'] = 'other'
    expect(() => repair.transform(result)).toThrow(/does not complete one started invocation/)
  })

  it.each(['multiple', 'pending', 'collision', 'no-ending', 'multiple-endings', 'name', 'arguments'] as const)(
    'rejects %s advertised empty-id call', (kind) => {
      const repair = new ReleasedEmptyToolCallRepair()
      const message = embeddedFixture()
      if (kind === 'multiple') content(message).push({ ...content(message)[1] })
      if (kind === 'pending') repair.transform(embeddedFixture())
      if (kind === 'collision') content(message).push({ ...content(message)[1], id: 'released-v1-tool-1-1-10-1' })
      if (kind === 'no-ending') data(message)['stream'] = []
      if (kind === 'multiple-endings') stream(message).push(stream(message)[5] as SessionFormatJsonObject)
      if (kind === 'name' || kind === 'arguments') content(message)[1]![kind] = 'different'
      expect(() => repair.transform(message)).toThrow(/ambiguous result pairing|collides|matching stream block-end|disagrees/)
    },
  )
})
