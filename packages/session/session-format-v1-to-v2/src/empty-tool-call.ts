/** Deterministic identifiers for fully paired released Tool calls with an empty provider id. */

import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'

interface PendingCall {
  readonly id: string
  readonly turn: number
  readonly step: number
  readonly name: string
  readonly arguments: string
  started: boolean
}

/** Repairs one unambiguous empty-id Tool lifecycle at a time during v1 migration. */
export class ReleasedEmptyToolCallRepair {
  private pending: PendingCall | undefined

  /**
   * Remap an empty id across its committed stream, message, invocation, and result.
   * @param event - v1 event with any Assistant stream already embedded.
   * @returns the original event or its detached repaired value.
   */
  transform(event: SessionFormatEvent): SessionFormatEvent {
    if (event.type === 'assistant/message') return this.message(event)
    const data = event.data as SessionFormatJsonObject
    if (event.type === 'tool/call' && data['callId'] === '') {
      const call = this.match(data)
      if (call.started || call.name !== data['name'] || call.arguments !== data['arguments']) {
        throw invalid('invocation does not match its advertised name and arguments')
      }
      call.started = true
      return { ...event, data: { ...data, callId: call.id } }
    }
    if (event.type === 'tool/result') {
      const message = data['message'] as SessionFormatJsonObject
      const source = message['source'] as SessionFormatJsonObject
      if (source['callId'] !== '') return event
      const call = this.match(data)
      const content = message['content'] as SessionFormatJsonObject[]
      if (!call.started || event.surfaceOp !== 'append' || content.length !== 1
        || content[0]?.['type'] !== 'tool-result' || content[0]['toolCallId'] !== '') {
        throw invalid('result does not complete one started invocation')
      }
      this.pending = undefined
      return {
        ...event,
        data: {
          ...data,
          message: {
            ...message,
            source: { ...source, callId: call.id },
            content: [{ ...content[0], toolCallId: call.id }],
          },
        },
      }
    }
    if (event.type === 'step/end' || event.type === 'turn/end') this.finish()
    return event
  }

  /** Require the repaired invocation to have a persisted matching result. */
  finish(): void {
    if (this.pending !== undefined) throw invalid('invocation has no matching result')
  }

  private match(data: SessionFormatJsonObject): PendingCall {
    const call = this.pending
    if (call === undefined || call.turn !== data['turn'] || call.step !== data['step']) {
      throw invalid('reference has no advertised invocation in this turn and step')
    }
    return call
  }

  private message(event: SessionFormatEvent): SessionFormatEvent {
    const data = event.data as SessionFormatJsonObject
    const message = data['message'] as SessionFormatJsonObject
    const content = message['content'] as SessionFormatJsonObject[]
    const index = content.findIndex(block => block['type'] === 'tool-call' && block['id'] === '')
    if (index < 0) return event
    const block = content[index] as SessionFormatJsonObject
    if (this.pending !== undefined
      || content.some((other, at) => at !== index && other['type'] === 'tool-call' && other['id'] === '')) {
      throw invalid('multiple advertised empty ids have ambiguous result pairing')
    }
    const turn = data['turn'] as number
    const step = data['step'] as number
    const id = `released-v1-tool-${turn}-${step}-${event.seq}-${index}`
    if (content.some(other => other['type'] === 'tool-call' && other['id'] === id)) {
      throw invalid('generated identifier collides with an advertised invocation')
    }
    const stream = data['stream'] as SessionFormatJsonObject[]
    const endings = stream.filter((record) => {
      if (record['type'] !== 'chunk') return false
      const chunk = record['chunk'] as SessionFormatJsonObject
      if (chunk['type'] !== 'block-end') return false
      const ended = chunk['block'] as SessionFormatJsonObject
      return ended['type'] === 'tool-call' && ended['id'] === ''
    })
    if (endings.length !== 1) throw invalid('committed message requires one matching stream block-end')
    const ending = endings[0]?.['chunk'] as SessionFormatJsonObject
    const ended = ending['block'] as SessionFormatJsonObject
    if (ended['name'] !== block['name'] || ended['arguments'] !== block['arguments']) {
      throw invalid('stream block-end disagrees with the committed invocation')
    }
    this.pending = {
      id, turn, step,
      name: block['name'] as string, arguments: block['arguments'] as string, started: false,
    }
    return {
      ...event,
      data: {
        ...data,
        message: { ...message, content: content.map((block, at) => at === index ? { ...block, id } : block) },
        stream: stream.map((record) => {
          if (record['type'] !== 'chunk') return record
          const chunk = record['chunk'] as SessionFormatJsonObject
          if (chunk['index'] !== ending['index']) return record
          if (chunk['type'] === 'tool-call-delta' && chunk['id'] === '') {
            return { ...record, chunk: { ...chunk, id } }
          }
          if (chunk === ending) return { ...record, chunk: { ...chunk, block: { ...ended, id } } }
          return record
        }),
      },
    }
  }
}

function invalid(detail: string): SessionFormatUnsupportedMigrationError {
  return new SessionFormatUnsupportedMigrationError(`released empty Tool-call id: ${detail}`)
}
