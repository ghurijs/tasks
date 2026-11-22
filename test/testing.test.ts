import { describe, expect, it } from 'vitest'
import { DBTaskResult, NotImplementedError, TaskResultStatus, taskBackends } from '../src/index'
import { captureTasks, DummyBackend, dummy, useTaskBackend } from '../src/testing'
import { localeStorage } from './demo'
import { add, boom, calls, flaky, flakyState, whichLocale } from './demo-tasks'
import { useHarness } from './helpers'

describe('dummy backend and test helpers', () => {
  useHarness(() => ({ database: false }))

  it('stores tasks without running them, like Django', async () => {
    const { backend, restore } = useTaskBackend(dummy())
    try {
      expect(taskBackends.get()).toBe(backend)
      expect(backend).toBeInstanceOf(DummyBackend)
      const r = await add.using({ priority: 9, runAfter: 60 }).enqueue(1, 2)
      expect(r.status).toBe(TaskResultStatus.READY)
      expect(backend.results).toEqual([r])
      expect(calls).toEqual([])
      await expect(add.getResult(r.id)).rejects.toThrow(NotImplementedError)
      backend.clear()
      expect(backend.results).toEqual([])
    } finally {
      restore()
    }
  })

  it('runPending() runs stored tasks with their context and retries', async () => {
    const { backend, restore } = useTaskBackend(dummy())
    try {
      flakyState.failuresLeft = 1
      const a = await add.enqueue(2, 2)
      const f = await flaky.enqueue('p')
      const b = await boom.enqueue()
      const l = await localeStorage.run('ja', () => whichLocale.enqueue())
      expect(await backend.runPending()).toBe(4)
      expect([a.returnValue, f.returnValue, f.attempts, b.status, l.returnValue]).toEqual([
        4,
        'ok p',
        2,
        'FAILED',
        'ja',
      ])
      expect(await backend.runPending()).toBe(0)
    } finally {
      restore()
    }
  })

  it('captureTasks() collects what a block enqueues', async () => {
    const results = await captureTasks(async () => {
      await add.enqueue(1, 1)
      await boom.enqueue()
    })
    expect(results.map((r) => r.task.modulePath)).toEqual(['demo.add', 'demo.boom'])
    expect(await captureTasks(() => undefined)).toEqual([])
  })

  it('overrides nest and restore in any order', () => {
    const one = useTaskBackend(dummy())
    const two = useTaskBackend(dummy())
    expect(taskBackends.get()).toBe(two.backend)
    one.restore()
    expect(taskBackends.get()).toBe(two.backend)
    two.restore()
    expect(taskBackends.get()).not.toBeInstanceOf(DummyBackend)
  })
})

describe('admin', () => {
  it('registers DBTaskResult read-only', async () => {
    const { site } = await import('@ghuri/admin')
    const { DBTaskResultAdmin } = await import('../src/admin')
    const registered =
      (site as any).getModelAdmin?.(DBTaskResult) ?? (site as any)._registry?.get?.(DBTaskResult)
    expect(registered).toBeInstanceOf(DBTaskResultAdmin)
    expect(await registered.hasAddPermission({} as any)).toBe(false)
    expect(registered.actions.map((a: any) => a.name ?? a.shortDescription)).toHaveLength(2)
  })
})
