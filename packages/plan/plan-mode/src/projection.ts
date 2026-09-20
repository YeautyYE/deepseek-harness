/** Replayable plan state and the Host projection-only plugin. */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { PlanProjection, PlanUnitState } from './types.ts'

const planUnitStateSchema: ZodType<PlanUnitState> = zod.object({
  active: zod.boolean(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    commandId: zod.string() as unknown as ZodType<CommandId>,
    wanted: zod.boolean(),
  }).strict().nullable(),
  activeAtLastHeader: zod.boolean().nullable(),
}).strict()

/** Wire payload schema of the `plan` projection. */
const planProjectionSchema: ZodType<PlanProjection> = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
})

/** Projection of logged plan selections and committed mode. */
export const planProjectionDefinition = {
  key: 'plan',
  stateVersion: 3,
  stateSchema: planUnitStateSchema,
  init: () => ({ active: false, wanted: null, running: null, activeAtLastHeader: null }),
  apply: (state, event) => {
    if (event.type === 'command/run' && event.data.name === 'plan') {
      if (event.data.args === undefined) return state
      const wanted = event.data.args.trim() !== 'off'
      return { ...state, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
      const wanted = event.data.kind === 'success' && state.running.wanted !== state.active
        ? state.running.wanted
        : null
      return { ...state, wanted, running: null }
    }
    if (event.type === 'plan/mode') {
      return { ...state, active: event.data.active, wanted: null }
    }
    if (event.type === 'request/header') {
      return { ...state, activeAtLastHeader: state.active }
    }
    return state
  },
  wire: {
    viewSchema: planProjectionSchema,
    view: (state) => {
      const wanted = state.running?.wanted ?? state.wanted
      return { active: state.active, pending: wanted !== null && wanted !== state.active }
    },
  },
} satisfies ProjectionDefinition<'plan', PlanUnitState>

/** Cordis function-plugin name. */
export const name = 'plan-projection'
/** Services required to display stored plan state without a live Agent. */
export const inject = ['sessionProjections']

/**
 * Register the plan fold without adding commands, prompts, or tools.
 * @param ctx - Host context carrying the Session projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(planProjectionDefinition)
}
