/** Cold browsing preserves persisted controls without retaining an Agent per visited Session. */

import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

function history(index: number): string {
  const header = {
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 1784974100000 + index, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0,
  }
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'system/message', surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createSystemMessage('', '@deepseek-ai/dsh-system-prompt') },
    },
    {
      type: 'user/message', surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: `Historical request ${index}` }], source: { kind: 'user' } }),
    },
    { type: 'session/title', data: { title: `Cold history ${index}`, messageSeqs: [], source: { kind: 'user' } } },
    { type: 'todo/write', data: { todos: [{ content: `Persisted task ${index}`, status: 'in_progress' }] } },
    { type: 'plan/mode', data: { active: true } },
    {
      type: 'goal/change',
      data: {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: `cold-goal-${index}`, revision: 1, objective: `Persisted objective ${index}`, phase: 'active', maxGoalRounds: 8 },
        roundsStarted: 0, createdAt: header.createdAt, updatedAt: header.createdAt,
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return [header, ...events.map((event, seq) => ({ ...event, seq, time: header.createdAt + seq }))]
    .map(event => JSON.stringify(event)).join('\n') + '\n'
}

it('browses cold histories with todos and plan state, then activates only an explicit command', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const ids = [0, 1, 2].map(index => SessionId(`cold-projections-${index}`))
    for (const [index, id] of ids.entries()) {
      await seedSession(scaffold, history(index), id, undefined, { createdAt: 1784974200000 - index * 1000 })
    }
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const consoleWatch = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]')
      await page.getByRole('treeitem').first().click()
      await expect.poll(() => page.getByRole('treeitem').count()).toBe(ids.length + 1)
      const plan = page.getByRole('button', { name: 'Plan mode on, press to turn off', exact: true })
      for (const [index, id] of ids.entries()) {
        // Header times pin the order before a cold read materializes title projections.
        await page.getByRole('treeitem').nth(index + 1).click()
        await page.getByText(`Historical request ${index}`, { exact: true }).waitFor()
        const todos = page.getByTestId('todo-panel')
        await todos.waitFor()
        const toggle = todos.locator('button[aria-expanded]')
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
        await todos.getByText(`Persisted task ${index}`, { exact: true }).waitFor()
        await plan.waitFor()
        await page.locator('[data-goal-bar]').getByRole('button', { name: 'Resume goal', exact: true }).waitFor()
        expect(scaffold.ctx.agents.get(id) === undefined).toBe(true)
        expect(scaffold.ctx.sessions.get(id) === undefined).toBe(true)
      }
      expect(scaffold.ctx.agents.roots()).toHaveLength(0)
      await plan.click()
      await plan.waitFor({ state: 'hidden' })
      expect(scaffold.ctx.agents.get(ids[2]!)).toBeDefined()
      expect(scaffold.ctx.agents.roots()).toHaveLength(1)
      expect(consoleWatch.warnings).toEqual([])
      expect(consoleWatch.pageErrors).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
