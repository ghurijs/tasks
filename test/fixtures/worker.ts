// @ghuri/tasks in workerd on D1: the bundle starts (no random values at module scope), a task goes through a real
// Cloudflare Queue and the app's queue() handler, and immediate() runs a task inside a request.
import { createApp, defineSettings, path } from '@ghuri/core'
import { d1 } from '@ghuri/orm'
import { migrate } from '@ghuri/orm/migrations'
import { cloudflareQueues, getTask, immediate, TasksConfig, task } from '../../src/index'

export const add = task(async (a: number, b: number) => a + b, { name: 'edge.add' })
export const double = task(async (n: number) => n * 2, { name: 'edge.double', backend: 'inline' })

export default createApp(
  defineSettings(() => ({
    SECRET_KEY: 'edge-secret',
    INSTALLED_APPS: [TasksConfig],
    DATABASES: { default: d1('DB') },
    TASKS: {
      default: cloudflareQueues({ queues: { default: 'TASKS_QUEUE' } }),
      inline: immediate(),
    },
    ROOT_URLCONF: [
      path('__setup/', async (c) => {
        await migrate({ interactive: false } as any)
        return c.json({ ok: true })
      }),
      path('__enqueue/', async (c) => {
        const result = await add.enqueue(2, 3)
        return c.json({ id: result.id, status: result.status })
      }),
      path('__result/', async (c) => {
        const result = await getTask('edge.add')!.getResult(c.req.query('id')!)
        return c.json({
          status: result.status,
          value: result.isFinished ? result.returnValue : null,
          workerIds: result.workerIds,
        })
      }),
      path('__immediate/', async (c) => {
        const result = await double.enqueue(21)
        return c.json({ status: result.status, value: result.returnValue, workerIds: result.workerIds })
      }),
    ],
  })),
  { checks: false },
)
