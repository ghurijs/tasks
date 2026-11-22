import { type MessageBatchLike, onQueue, type QueueMessageLike } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  CloudflareQueuesBackend,
  cloudflareQueues,
  DBTaskResult,
  InvalidTask,
  NotImplementedError,
  TaskResultStatus,
  taskBackends,
} from '../src/index'
import { localeStorage } from './demo'
import { add, boom, calls, emails, flaky, flakyState, whichLocale } from './demo-tasks'
import { type Harness, useHarness } from './helpers'

interface Sent {
  body: any
  options?: { delaySeconds?: number }
}

function fakeQueue() {
  const sent: Sent[] = []
  return {
    sent,
    async send(body: unknown, options?: { delaySeconds?: number }) {
      sent.push({ body: JSON.parse(JSON.stringify(body)), options })
    },
  }
}

interface FakeMessage extends QueueMessageLike<any> {
  acked: boolean
  retried: { delaySeconds?: number } | null
}

function message(body: unknown, attempts = 1): FakeMessage {
  const m: FakeMessage = {
    id: `msg-${Math.random()}`,
    timestamp: new Date(),
    body,
    attempts,
    acked: false,
    retried: null,
    ack() {
      m.acked = true
    },
    retry(opts) {
      m.retried = opts ?? {}
    },
  }
  return m
}

function batch(messages: FakeMessage[], queue = 'mysite-tasks'): MessageBatchLike<any> {
  return { queue, messages, ackAll() {}, retryAll() {} }
}

const queues = { default: 'TASKS_QUEUE', emails: 'EMAILS_QUEUE' }

function harness(database: boolean) {
  const tasksQueue = fakeQueue()
  const emailsQueue = fakeQueue()
  const h = useHarness(() => ({
    database,
    env: { TASKS_QUEUE: tasksQueue, EMAILS_QUEUE: emailsQueue },
    settings: { TASKS: { default: cloudflareQueues({ queues }) } },
  }))
  return {
    h,
    tasksQueue,
    emailsQueue,
    reset() {
      tasksQueue.sent.length = 0
      emailsQueue.sent.length = 0
    },
  }
}

/** Deliver `sent` messages to the app's queue() handler, like Cloudflare does. */
async function deliver(h: Harness, sent: Sent[], attempts = 1): Promise<FakeMessage[]> {
  const msgs = sent.map((s) => message(s.body, attempts))
  await h.app.queue(batch(msgs), h.env)
  return msgs
}

describe('cloudflareQueues without the tasks app', () => {
  const q = harness(false)

  it('sends a task message to the queue of the task', async () => {
    q.reset()
    const result = await localeStorage.run('bn', () => add.enqueue(2, 3))
    await emails.enqueue('a@example.com')
    expect(result.status).toBe(TaskResultStatus.READY)
    expect(q.tasksQueue.sent).toHaveLength(1)
    expect(q.tasksQueue.sent[0].body).toMatchObject({
      type: 'ghuri.tasks.run',
      id: result.id,
      task: 'demo.add',
      args: [2, 3],
      backend: 'default',
      queueName: 'default',
      carried: { locale: 'bn' },
    })
    expect(q.tasksQueue.sent[0].options).toBeUndefined()
    expect(q.emailsQueue.sent.map((s) => s.body.task)).toEqual(['demo.emails'])
    const backend = taskBackends.get()
    expect(backend).toBeInstanceOf(CloudflareQueuesBackend)
    expect([backend.supportsDefer, backend.supportsPriority, backend.supportsGetResult]).toEqual([
      true,
      false,
      false,
    ])
    await expect(add.getResult(result.id)).rejects.toThrow(NotImplementedError)
  })

  it('defers with delaySeconds up to 24 hours', async () => {
    q.reset()
    await add.using({ runAfter: 90 }).enqueue(1, 1)
    expect(q.tasksQueue.sent[0].options).toEqual({ delaySeconds: 90 })
    await expect(add.using({ runAfter: 86_401 }).enqueue(1, 1)).rejects.toThrow(/at most 86400s/)
    await expect(add.using({ priority: 5 }).enqueue(1, 1)).rejects.toThrow(
      'Backend does not support setting priority of tasks.',
    )
  })

  it('refuses messages over 128 KB', async () => {
    await expect(add.enqueue('x'.repeat(130_000) as any, 1)).rejects.toThrow(InvalidTask)
  })

  it('runs task messages in the queue handler and acks them', async () => {
    q.reset()
    await localeStorage.run('fr', () => whichLocale.enqueue())
    await add.enqueue(4, 5)
    const msgs = await deliver(q.h, q.tasksQueue.sent)
    expect(msgs.map((m) => [m.acked, m.retried])).toEqual([
      [true, null],
      [true, null],
    ])
    expect(calls).toEqual(['add 4 5'])
  })

  it('retries failed attempts with the task retryDelay, then acks the final failure', async () => {
    q.reset()
    flakyState.failuresLeft = 5
    await flaky.enqueue('z')
    const first = await deliver(q.h, q.tasksQueue.sent, 1)
    expect([first[0].acked, first[0].retried]).toEqual([false, { delaySeconds: 30 }])
    const last = await deliver(q.h, q.tasksQueue.sent, 3) // third delivery = third attempt (maxAttempts 3)
    expect([last[0].acked, last[0].retried]).toEqual([true, null])
    await boom.enqueue()
    const failed = await deliver(q.h, q.tasksQueue.sent.slice(-1))
    expect(failed[0].acked).toBe(true)
  })

  it('leaves messages that are not tasks to other consumers, and retries them when there is none', async () => {
    const orphan = message({ type: 'something.else' })
    await q.h.app.queue(batch([orphan]), q.h.env)
    expect([orphan.acked, orphan.retried]).toEqual([false, {}])
    const seen: unknown[] = []
    const off = onQueue('mysite-tasks', async (b) => {
      for (const m of b.messages) if (!(m.body as any)?.type?.startsWith('ghuri.tasks')) seen.push(m.body)
    })
    try {
      const other = message({ type: 'something.else' })
      await q.h.app.queue(batch([other]), q.h.env)
      expect([other.acked, other.retried]).toEqual([false, null])
      expect(seen).toEqual([{ type: 'something.else' }])
    } finally {
      off()
    }
  })

  it('needs the producer binding', async () => {
    const { restore } = (await import('../src/testing')).useTaskBackend(
      cloudflareQueues({ queues: { default: 'MISSING' } }),
    )
    try {
      await expect(add.enqueue(1, 1)).rejects.toThrow(
        "Queue producer binding 'MISSING' (queue 'default') not found",
      )
    } finally {
      restore()
    }
    expect(() => cloudflareQueues({ queues: {} }).create('x')).toThrow(/needs queues/)
  })
})

describe('cloudflareQueues with the tasks app', () => {
  const q = harness(true)

  it('stores results, so getResult() and refresh() work', async () => {
    q.reset()
    expect(taskBackends.get().supportsGetResult).toBe(true)
    const result = await add.enqueue(3, 4)
    expect((await DBTaskResult.objects.get({ pk: result.id })).status).toBe('READY')
    await deliver(q.h, q.tasksQueue.sent)
    await result.refresh()
    expect([result.status, result.returnValue, result.attempts]).toEqual(['SUCCESSFUL', 7, 1])
  })

  it('keeps attempts and errors across redeliveries', async () => {
    q.reset()
    flakyState.failuresLeft = 1
    const result = await flaky.enqueue('r')
    const first = await deliver(q.h, q.tasksQueue.sent, 1)
    expect(first[0].retried).toEqual({ delaySeconds: 30 })
    await result.refresh()
    expect([result.status, result.attempts, result.errors.length]).toEqual(['READY', 1, 1])
    await deliver(q.h, q.tasksQueue.sent, 2)
    await result.refresh()
    expect([result.status, result.returnValue, result.attempts]).toEqual(['SUCCESSFUL', 'ok r', 2])
  })

  it('acks a message delivered again after its task finished', async () => {
    q.reset()
    await add.enqueue(1, 1)
    await deliver(q.h, q.tasksQueue.sent)
    const again = await deliver(q.h, q.tasksQueue.sent)
    expect(again[0].acked).toBe(true)
    expect(calls).toEqual(['add 1 1'])
  })

  it('deletes the stored result when sending fails', async () => {
    const before = await DBTaskResult.objects.count()
    const send = q.tasksQueue.send
    q.tasksQueue.send = async () => {
      throw new Error('queue down')
    }
    try {
      await expect(add.enqueue(1, 1)).rejects.toThrow('queue down')
    } finally {
      q.tasksQueue.send = send
    }
    expect(await DBTaskResult.objects.count()).toBe(before)
  })
})
