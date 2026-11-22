import { bufferIO, callCommand, onSchedule, taskHandlers } from '@ghuri/core'
import { connections } from '@ghuri/orm'
import { MigrationLoader, makeMigrations, showMigrations } from '@ghuri/orm/migrations'
import { describe, expect, it } from 'vitest'
import {
  type DatabaseBackend,
  DBTaskResult,
  database,
  drainTasks,
  InvalidTaskBackend,
  runWorker,
  TaskResultDoesNotExist,
  TaskResultMismatch,
  TaskResultStatus,
  taskBackends,
  taskFinished,
} from '../src/index'
import { useTaskBackend } from '../src/testing'
import { localeStorage } from './demo'
import { add, boom, calls, emails, flaky, flakyState, whichLocale } from './demo-tasks'
import { backends, useHarness } from './helpers'

for (const using of backends) {
  describe(`database backend (${using})`, () => {
    const h = useHarness(() => ({
      using,
      settings: { TASKS: { default: database({ queues: ['default', 'emails'] }), other: database() } },
    }))

    it('ships 0001_initial, applied by the test database, with no missing changes', async () => {
      const loader = await MigrationLoader.load({ connection: null })
      expect(loader.getMigration('tasks', '0001_initial').operations.map((o) => o.describe())).toEqual([
        'Create model DBTaskResult',
      ])
      const status = await showMigrations({ appLabels: ['tasks'], connection: await connections.get() })
      expect(status.map((s) => [s.name, s.applied])).toEqual([['0001_initial', true]])
      const res = await makeMigrations({ appLabels: ['tasks'], check: true, write: false })
      expect(res.migrations).toEqual([])
      expect(h.db!.using).toBe(using)
    })

    it('stores enqueued tasks as READY rows and loads them with getResult()', async () => {
      const result = await localeStorage.run('bn', () => add.using({ priority: 3 }).enqueue(2, 3))
      expect(result.status).toBe(TaskResultStatus.READY)
      expect(calls).toEqual([])
      const row = await DBTaskResult.objects.get({ pk: result.id })
      expect([row.taskPath, row.args, row.priority, row.queueName, row.backendName, row.carried]).toEqual([
        'demo.add',
        [2, 3],
        3,
        'default',
        'default',
        { locale: 'bn' },
      ])
      const loaded = await add.getResult(result.id)
      expect([loaded.id, loaded.status, loaded.task.priority, loaded.args]).toEqual([
        result.id,
        'READY',
        3,
        [2, 3],
      ])
      expect(loaded.enqueuedAt).toBeInstanceOf(Date)
      await expect(add.getResult('00000000-0000-7000-8000-000000000000')).rejects.toThrow(
        TaskResultDoesNotExist,
      )
      await expect(add.getResult('not-a-uuid')).rejects.toThrow(TaskResultDoesNotExist)
      await expect(boom.getResult(result.id)).rejects.toThrow(TaskResultMismatch)
    })

    it('runs ready tasks by priority, then age, and refresh() sees the outcome', async () => {
      const low = await add.enqueue(1, 1)
      const high = await add.using({ priority: 50 }).enqueue(2, 2)
      const failing = await boom.enqueue()
      const { processed } = await runWorker({ batch: true, workerId: 'w1' })
      expect(processed).toBe(3)
      expect(calls).toEqual(['add 2 2', 'add 1 1', 'boom'])
      await low.refresh()
      expect([low.status, low.returnValue, low.attempts, low.workerIds]).toEqual(['SUCCESSFUL', 2, 1, ['w1']])
      expect(low.finishedAt).toBeInstanceOf(Date)
      await failing.refresh()
      expect(failing.status).toBe('FAILED')
      expect(failing.errors[0].exceptionClassPath).toBe('TypeError')
      expect((await add.getResult(high.id)).returnValue).toBe(4)
    })

    it('restores the captured request context for each attempt', async () => {
      const r = await localeStorage.run('en-GB', () => whichLocale.enqueue())
      await runWorker({ batch: true })
      expect((await whichLocale.getResult(r.id)).returnValue).toBe('en-GB')
    })

    it('waits for runAfter, and retries failed attempts after retryDelay', async () => {
      const later = await add.using({ runAfter: 3600 }).enqueue(5, 5)
      expect(later.runAfter!.getTime()).toBeGreaterThan(Date.now() + 3500_000)
      flakyState.failuresLeft = 1
      const r = await flaky.enqueue('a')
      expect((await runWorker({ batch: true })).processed).toBe(1) // flaky fails once; add waits
      await r.refresh()
      expect([r.status, r.attempts, r.errors.length]).toEqual(['READY', 1, 1])
      expect(r.runAfter!.getTime()).toBeGreaterThan(Date.now() + 25_000) // retryDelay: 30
      expect((await runWorker({ batch: true })).processed).toBe(0)
      await DBTaskResult.objects.filter({ pk: r.id }).update({ runAfter: new Date(Date.now() - 1000) })
      expect((await runWorker({ batch: true })).processed).toBe(1)
      await r.refresh()
      expect([r.status, r.returnValue, r.attempts]).toEqual(['SUCCESSFUL', 'ok a', 2])
      expect(calls).toEqual(['flaky a', 'flaky a'])
      expect((await add.getResult(later.id)).status).toBe('READY')
    })

    it('honours queue names and backends', async () => {
      await emails.enqueue('a@example.com')
      await add.enqueue(1, 2)
      await add.using({ backend: 'other' }).enqueue(3, 4)
      expect((await runWorker({ batch: true, queueNames: ['emails'] })).processed).toBe(1)
      expect((await runWorker({ batch: true })).processed).toBe(1)
      expect((await runWorker({ batch: true, backend: 'other' })).processed).toBe(1)
      expect(calls).toEqual(['add 1 2', 'add 3 4'])
    })

    it('never runs a task twice when workers race', async () => {
      for (let i = 0; i < 8; i++) await add.enqueue(i, 0)
      const results = await Promise.all([1, 2, 3].map((n) => runWorker({ batch: true, workerId: `w${n}` })))
      expect(results.reduce((s, r) => s + r.processed, 0)).toBe(8)
      expect(calls.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `add ${i} 0`).sort())
      expect(await DBTaskResult.objects.filter({ status: 'SUCCESSFUL' }).count()).toBe(8)
    })

    it('stops at maxTasks, the deadline or the abort signal', async () => {
      for (let i = 0; i < 3; i++) await add.enqueue(i, i)
      expect((await runWorker({ batch: true, maxTasks: 2 })).processed).toBe(2)
      expect((await runWorker({ batch: true, deadline: Date.now() - 1 })).processed).toBe(0)
      const controller = new AbortController()
      controller.abort()
      expect((await runWorker({ signal: controller.signal })).processed).toBe(0)
    })

    it('recovers tasks whose worker went away', async () => {
      const finished: string[] = []
      const receiver = ({ taskResult }: any) => void finished.push(taskResult.status)
      const r1 = await add.enqueue(1, 1)
      const r2 = await flaky.enqueue('b')
      const old = new Date(Date.now() - 2 * 3600_000)
      await DBTaskResult.objects
        .filter({ pk__in: [r1.id, r2.id] })
        .update({ status: 'RUNNING', lastAttemptedAt: old })
      taskFinished.connect(receiver)
      try {
        expect(await (taskBackends.get() as DatabaseBackend).recoverStale()).toBe(2)
      } finally {
        taskFinished.disconnect(receiver)
      }
      await r1.refresh()
      await r2.refresh()
      expect([r1.status, r1.attempts, r1.errors[0].exceptionClassPath]).toEqual(['FAILED', 1, 'WorkerLost'])
      expect([r2.status, r2.attempts]).toEqual(['READY', 1]) // flaky has maxAttempts: 3
      expect(finished).toEqual(['FAILED'])
    })

    it('fails rows of tasks that are not registered', async () => {
      const row = await DBTaskResult.objects.create({ taskPath: 'gone.task', backendName: 'default' } as any)
      await runWorker({ batch: true })
      const r = await (taskBackends.get() as DatabaseBackend).getResult(String(row.pk))
      expect(r.status).toBe('FAILED')
      expect(r.errors[0].traceback).toContain("Task 'gone.task' is not registered")
    })

    it('drainTasks() runs ready tasks from a Cron Trigger handler', async () => {
      await add.enqueue(7, 8)
      const off = onSchedule('* * * * *', drainTasks({ seconds: 5 }))
      try {
        await h.app.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, h.env)
      } finally {
        off()
      }
      expect(calls).toEqual(['add 7 8'])
    })

    it('db_worker --batch runs the queue and exits', async () => {
      await add.enqueue(1, 2)
      await emails.enqueue('x@example.com')
      const io = bufferIO()
      await callCommand('db_worker', { batch: true, queueName: 'default,emails', workerId: 'cli' }, io)
      expect(io.out.join('\n')).toContain(
        "Worker cli running tasks from backend 'default' (queues default, emails).",
      )
      expect(io.out.join('\n')).toContain('Ran 2 task(s).')
      expect(await DBTaskResult.objects.filter({ status: 'SUCCESSFUL' }).count()).toBe(2)
      expect(taskHandlers.schedulesFor('* * * * *')).toEqual([])
    })

    it('prune_db_task_results deletes old finished results', async () => {
      const ok = await add.enqueue(1, 1)
      const failed = await boom.enqueue()
      const ready = await add.enqueue(2, 2)
      await runWorker({ batch: true, maxTasks: 2 })
      const old = new Date(Date.now() - 30 * 86_400_000)
      await DBTaskResult.objects.filter({ pk__in: [ok.id, failed.id] }).update({ finishedAt: old })
      const dry = bufferIO()
      await callCommand('prune_db_task_results', { dryRun: true }, dry)
      expect(dry.out).toEqual(['Would delete 2 task result(s).'])
      const io = bufferIO()
      await callCommand('prune_db_task_results', { onlyFailed: true }, io)
      expect(io.out).toEqual(['Deleted 1 task result(s).'])
      expect((await DBTaskResult.objects.all().fetch()).map((r) => String(r.pk)).sort()).toEqual(
        [ok.id, ready.id].sort(),
      )
    })

    it('db_worker refuses a backend that is not database()', async () => {
      const { restore } = useTaskBackend(database(), 'x')
      restore()
      await expect(runWorker({ backend: 'missing' })).rejects.toThrow(InvalidTaskBackend)
    })
  })
}
