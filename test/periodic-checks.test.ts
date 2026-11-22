import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImproperlyConfigured, runChecks, taskHandlers } from '@ghuri/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseJsonc } from '../src/checks'
import { cloudflareQueues, database, dummy, immediate, periodicTask, periodicTasks } from '../src/index'
import { useTaskBackend } from '../src/testing'
import { add, calls, emails, flaky } from './demo-tasks'
import { useHarness } from './helpers'

const ids = (msgs: Array<{ id?: string }>) => msgs.map((m) => m.id)

describe('periodic tasks', () => {
  const h = useHarness(() => ({ database: false }))
  const offs: Array<() => void> = []
  afterEach(() => {
    for (const off of offs.splice(0)) off()
  })

  it('enqueue the task when the Cron Trigger fires', async () => {
    offs.push(periodicTask('0 3 * * *', add, { args: [1, 2] }))
    expect(taskHandlers.crons()).toEqual(['0 3 * * *'])
    expect(periodicTasks().map((p) => [p.cron, p.task.modulePath, p.args])).toEqual([
      ['0 3 * * *', 'demo.add', [1, 2]],
    ])
    const { backend, restore } = useTaskBackend(dummy())
    try {
      await h.app.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, h.env)
      expect(backend.results.map((r) => [r.task.modulePath, r.args])).toEqual([['demo.add', [1, 2]]])
      expect(calls).toEqual([])
    } finally {
      restore()
    }
  })

  it('run in the handler with inline: true', async () => {
    offs.push(periodicTask('*/5 * * * *', add, { args: [2, 2], inline: true }))
    await h.app.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, h.env)
    expect(calls).toEqual(['add 2 2'])
  })

  it('validate the cron and the arguments', () => {
    expect(() => periodicTask('0 3 * *', add)).toThrow(ImproperlyConfigured)
    expect(() => periodicTask('* * * * *', add, { args: [new Date() as any, 1] })).toThrow(/must be JSON/)
    expect(periodicTasks()).toEqual([])
  })
})

describe('system checks', () => {
  useHarness(() => ({ database: false }))
  let dir: string | null = null
  afterEach(() => {
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function wrangler(config: unknown): void {
    dir = mkdtempSync(join(tmpdir(), 'ghuri-tasks-'))
    writeFileSync(join(dir, 'wrangler.jsonc'), `// test\n${JSON.stringify(config, null, 2)}\n`)
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
  }

  const run = async (deploy = false) =>
    (await runChecks({ tags: ['tasks'], deploy })).filter((m) => m.id?.startsWith('tasks.'))

  it('pass when every task queue is allowed', async () => {
    expect(ids(await run())).toEqual(['tasks.E002']) // the default allows only 'default'; demo.emails uses 'emails'
    const { restore } = useTaskBackend(immediate({ queues: [] }))
    try {
      expect(ids(await run())).toEqual([])
    } finally {
      restore()
    }
  })

  it('tasks.E004: database() without the tasks app', async () => {
    const { restore } = useTaskBackend(database({ queues: [] }))
    try {
      expect(ids(await run())).toEqual(['tasks.E004'])
    } finally {
      restore()
    }
  })

  it('tasks.E002: a task queue the backend does not have', async () => {
    const { restore } = useTaskBackend(dummy({ queues: ['default'] }))
    try {
      const msgs = await run()
      expect(ids(msgs)).toEqual(['tasks.E002'])
      expect(msgs[0].msg).toContain("Task 'demo.emails' uses the queue 'emails'")
    } finally {
      restore()
    }
    expect(emails.queueName).toBe('emails')
  })

  it('tasks.W001 (deploy): the immediate backend', async () => {
    const { restore } = useTaskBackend(immediate({ queues: [] }))
    try {
      expect(ids(await run(true))).toEqual(['tasks.W001'])
    } finally {
      restore()
    }
  })

  it('tasks.E003, E005, W004 and W002 read wrangler.jsonc', async () => {
    const off = periodicTask('0 3 * * *', add)
    const { restore } = useTaskBackend(
      cloudflareQueues({ queues: { default: 'TASKS_QUEUE', emails: 'EMAILS_QUEUE' } }),
    )
    try {
      wrangler({
        triggers: { crons: ['*/5 * * * *'] },
        queues: {
          producers: [
            { binding: 'TASKS_QUEUE', queue: 'site-tasks' },
            { binding: 'OTHER', queue: 'site-other' },
          ],
          consumers: [{ queue: 'site-tasks', max_retries: 1 }],
        },
      })
      const msgs = await run()
      expect(ids(msgs).sort()).toEqual(['tasks.E003', 'tasks.E005', 'tasks.W002'])
      expect(msgs.find((m) => m.id === 'tasks.W002')!.msg).toContain("Task 'demo.flaky' may run 3 times")
      expect(msgs.find((m) => m.id === 'tasks.E005')!.msg).toContain("'EMAILS_QUEUE'")

      wrangler({
        triggers: { crons: ['0 3 * * *'] },
        queues: {
          producers: [
            { binding: 'TASKS_QUEUE', queue: 'site-tasks' },
            { binding: 'EMAILS_QUEUE', queue: 'site-emails' },
          ],
          consumers: [{ queue: 'site-tasks', max_retries: 5 }],
        },
      })
      expect(ids(await run())).toEqual(['tasks.W004'])
    } finally {
      restore()
      off()
    }
    expect(flaky.maxAttempts).toBe(3)
  })

  it('parseJsonc strips comments and trailing commas, not strings', () => {
    expect(parseJsonc('{ "a": "http://x/*y*/", // c\n /* d */ "b": [1, 2,], }')).toEqual({
      a: 'http://x/*y*/',
      b: [1, 2],
    })
  })
})
