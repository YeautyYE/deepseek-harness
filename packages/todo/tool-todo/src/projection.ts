/** Replayable Todo state and the Host projection-only plugin. */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TodoItem } from './types.ts'

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/** Latest whole Todo list, cleared by the next turn's start. */
export const todosProjectionDefinition = {
  key: 'todos',
  stateSchema: todosProjectionSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === 'todo/write') return event.data.todos
    if (event.type === 'turn/start') return null
    return state
  },
  wire: { viewSchema: todosProjectionSchema, view: state => state },
  stateVersion: 2,
} satisfies ProjectionDefinition<'todos', TodoItem[] | null>

/** Cordis function-plugin name. */
export const name = 'todo-projection'
/** Services required to display stored Todos without a live Agent. */
export const inject = ['sessionProjections']

/**
 * Register the Todo fold without adding model tools.
 * @param ctx - Host context carrying the Session projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(todosProjectionDefinition)
}
