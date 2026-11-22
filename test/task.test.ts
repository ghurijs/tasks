import { describe, expect, it } from 'vitest'
import {
  defaultTaskBackend,
  getTask,
  ImmediateBackend,
  InvalidTask,
  InvalidTaskBackend,
  NotImplementedError,
  registeredTasks,
  Task,
  TaskResultNotReady,
  TaskResultStatus,
  task,
  taskBackends,
  taskEnqueued,
  taskFinished,
  taskStarted,
} from '../src/index'
import { localeStorage } from './demo'
import {
  add,
  attemptNumber,
  badReturn,
  boom,
  calls,
  flaky,
  flakyState,
  nothing,
  whichLocale,
} from './demo-tasks'
import { useHarness } from './helpers'

describe('tasks', () => {
  useHarness(() => ({ database: false }))

  it('names app tasks <app label>.<export name> at populate', () => {
    expect(add.modulePath).toBe('demo.add')
    expect(add.name).toBe('add')
    expect(getTask('demo.add')).toBe(add)
    expect([...registeredTasks().keys()]).toContain('demo.flaky')
  })

  it('refuses to enqueue a task without a name', async () => {
    const anonymous = task(async () => 1)
    await expect(anonymous.enqueue()).rejects.toThrow(InvalidTask)
    const named = task(async () => 2, { name: 'custom.two' })
    expect(named.modulePath).toBe('custom.two')
    expect(getTask('custom.two')).toBe(named)
  })

  it('using() returns a copy with other options', () => {
    const urgent = add.using({ priority: 10, queueName: 'fast' })
    expect(urgent).not.toBe(add)
    expect(urgent).toBeInstanceOf(Task)
    expect([urgent.priority, urgent.queueName, urgent.modulePath]).toEqual([10, 'fast', 'demo.add'])
    expect([add.priority, add.queueName]).toEqual([0, 'default'])
    expect(() => add.using({ priority: 101 })).toThrow(InvalidTask)
    expect(() => add.using({ priority: 1.5 })).toThrow(InvalidTask)
    expect(() => add.using({ runAfter: -1 })).toThrow(InvalidTask)
    expect(Object.isFrozen(add)).toBe(true)
  })

  it('validates options', () => {
    expect(() => task(async () => 1, { maxAttempts: 0 })).toThrow(InvalidTask)
    expect(() => task(async () => 1, { priority: -101 })).toThrow(InvalidTask)
    expect(() => task(async () => 1, { queueName: '' })).toThrow(InvalidTask)
  })

  it('refuses arguments that are not JSON', async () => {
    await expect(add.enqueue(new Date() as any, 1)).rejects.toThrow(/args\[0\] is a Date/)
    await expect(add.enqueue(undefined as any, 1)).rejects.toThrow(/args\[0\] is undefined/)
    await expect(add.enqueue(Number.NaN, 1)).rejects.toThrow(/NaN/)
    await expect(add.enqueue({ a: new Map() } as any, 1)).rejects.toThrow(/args\[0\]\.a is a Map/)
  })

  it('call() runs the function directly', async () => {
    expect(await add.call(2, 3)).toBe(5)
    await expect(attemptNumber.call()).rejects.toThrow(InvalidTask)
  })
})

describe('immediate backend (the default)', () => {
  useHarness(() => ({ database: false }))

  it('is used when TASKS is not set', () => {
    expect(taskBackends.get()).toBeInstanceOf(ImmediateBackend)
    expect(defaultTaskBackend).toBeInstanceOf(ImmediateBackend)
    expect(defaultTaskBackend.supportsDefer).toBe(false)
    expect(() => taskBackends.get('other')).toThrow(InvalidTaskBackend)
  })

  it('runs the task inside enqueue()', async () => {
    const result = await add.enqueue(2, 3)
    expect(result.status).toBe(TaskResultStatus.SUCCESSFUL)
    expect(result.returnValue).toBe(5)
    expect(result.isFinished).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.args).toEqual([2, 3])
    expect(result.backend).toBe('default')
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(result.enqueuedAt).toBeInstanceOf(Date)
    expect(result.startedAt!.getTime()).toBeLessThanOrEqual(result.finishedAt!.getTime())
    expect(result.workerIds).toHaveLength(1)
    expect(calls).toEqual(['add 2 3'])
    expect((await nothing.enqueue()).returnValue).toBeNull()
  })

  it('stores errors instead of throwing them', async () => {
    const result = await boom.enqueue()
    expect(result.status).toBe(TaskResultStatus.FAILED)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].exceptionClassPath).toBe('TypeError')
    expect(result.errors[0].traceback).toContain('kaboom')
    expect(() => result.returnValue).toThrow(TaskResultNotReady)
  })

  it('retries at once while attempts remain', async () => {
    flakyState.failuresLeft = 2
    const result = await flaky.enqueue('x')
    expect(result.status).toBe(TaskResultStatus.SUCCESSFUL)
    expect(result.returnValue).toBe('ok x')
    expect(result.attempts).toBe(3)
    expect(result.errors.map((e) => e.traceback.split('\n')[0])).toEqual(['Error: not yet', 'Error: not yet'])
    flakyState.failuresLeft = 5
    const failed = await flaky.enqueue('y')
    expect(failed.status).toBe(TaskResultStatus.FAILED)
    expect(failed.attempts).toBe(3)
  })

  it('passes a TaskContext with the attempt number', async () => {
    const result = await attemptNumber.enqueue()
    expect(result.returnValue).toBe(1)
  })

  it('fails tasks whose return value is not JSON', async () => {
    const result = await badReturn.enqueue()
    expect(result.status).toBe(TaskResultStatus.FAILED)
    expect(result.errors[0].traceback).toMatch(/return value is a Date/)
  })

  it('refuses runAfter and accepts priority, like Django', async () => {
    await expect(add.using({ runAfter: 60 }).enqueue(1, 1)).rejects.toThrow(
      'Backend does not support run_after.',
    )
    expect((await add.using({ priority: 5 }).enqueue(1, 1)).status).toBe(TaskResultStatus.SUCCESSFUL)
    await expect(add.getResult('nope')).rejects.toThrow(NotImplementedError)
  })

  it('refuses queues the backend does not have', async () => {
    await expect(add.using({ queueName: 'emails' }).enqueue(1, 1)).rejects.toThrow(
      "Queue 'emails' is not valid for backend 'default'.",
    )
  })

  it('sends taskEnqueued, taskStarted and taskFinished', async () => {
    const seen: string[] = []
    const on =
      (name: string) =>
      ({ taskResult, sender }: any) => {
        seen.push(`${name} ${taskResult.status} ${sender === ImmediateBackend}`)
      }
    const receivers = [on('enqueued'), on('started'), on('finished')]
    taskEnqueued.connect(receivers[0])
    taskStarted.connect(receivers[1])
    taskFinished.connect(receivers[2])
    try {
      await add.enqueue(1, 2)
    } finally {
      taskEnqueued.disconnect(receivers[0])
      taskStarted.disconnect(receivers[1])
      taskFinished.disconnect(receivers[2])
    }
    expect(seen).toEqual(['enqueued READY true', 'started RUNNING true', 'finished SUCCESSFUL true'])
  })

  it('restores the request context captured at enqueue', async () => {
    const result = await localeStorage.run('bn', () => whichLocale.enqueue())
    expect(result.returnValue).toBe('bn')
    expect((await whichLocale.enqueue()).returnValue).toBeNull()
  })
})

describe('interop', () => {
  it('publishes task() and getTask() on globalThis for packages that do not import @ghuri/tasks', async () => {
    const { TASKS_INTEROP_KEY } = await import('../src/index')
    const interop = (globalThis as any)[Symbol.for(TASKS_INTEROP_KEY)]
    expect(interop.version).toBe(1)
    expect(interop.task).toBe(task)
    expect(interop.getTask('demo.add')).toBe(add)
  })
})
