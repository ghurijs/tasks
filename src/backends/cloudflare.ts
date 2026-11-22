import {
  apps,
  type CheckMessage,
  checks,
  ImproperlyConfigured,
  type MessageBatchLike,
  onQueue,
  type QueueMessageLike,
  taskHandlers,
  tryGetContext,
} from '@ghuri/core'
import { QUEUES_MAX_DELAY_SECONDS, QUEUES_MAX_MESSAGE_BYTES, TASK_MESSAGE_TYPE } from '../constants'
import { InvalidTask, TaskResultDoesNotExist } from '../errors'
import { newWorkerId } from '../ids'
import type { JsonValue } from '../json'
import { DBTaskResult } from '../models'
import { backendConfig, type TaskBackendConfig, taskBackends } from '../registry'
import { TaskResult, TaskResultStatus } from '../result'
import { runAttempt } from '../runner'
import { getTask, type Task } from '../task'
import { type BaseBackendOptions, BaseTaskBackend } from './base'
import { resultFromRow, rowFields, unknownTask } from './database'

export interface CloudflareQueuesOptions extends Omit<BaseBackendOptions, 'queues'> {
  /** Queue name → Queue producer binding: `{ default: 'TASKS_QUEUE', emails: 'EMAILS_QUEUE' }`. */
  queues: Record<string, string>
  /**
   * Store results in `tasks_dbtaskresult` so `getResult()` works (default: when the `tasks` app is installed).
   * `false` saves the database writes for fire-and-forget queues.
   */
  results?: boolean
}

/** The body of a task message on a Cloudflare Queue. */
export interface TaskMessage {
  type: typeof TASK_MESSAGE_TYPE
  /** Task result id. */
  id: string
  /** The task's `modulePath`. */
  task: string
  args: JsonValue[]
  /** `TASKS` alias of the backend that sent it. */
  backend: string
  queueName: string
  priority: number
  enqueuedAt: string
  /** Captured request context (tenant, …). */
  carried?: Record<string, string>
}

function isTaskMessage(body: unknown): body is TaskMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as TaskMessage).type === TASK_MESSAGE_TYPE &&
    typeof (body as TaskMessage).task === 'string' &&
    typeof (body as TaskMessage).id === 'string'
  )
}

interface QueueProducer {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<unknown>
}

const WORKER_ID = newWorkerId()

/**
 * Sends tasks to Cloudflare Queues and runs them in the Worker's `queue()` handler. Supports `runAfter` up to 24
 * hours (Queues' `delaySeconds` limit) and retries (`msg.retry({ delaySeconds })`); priority is not supported.
 * With the `tasks` app installed, results are also stored in the database, so `getResult()` works.
 */
export class CloudflareQueuesBackend extends BaseTaskBackend {
  override get supportsDefer(): boolean {
    return true
  }
  /** Queue name → producer binding. */
  readonly bindings: Record<string, string>
  private readonly resultsOption: boolean | undefined

  constructor(alias: string, options: CloudflareQueuesOptions) {
    if (!options?.queues || !Object.keys(options.queues).length) {
      throw new ImproperlyConfigured(
        `cloudflareQueues() for '${alias}' needs queues: { default: '<producer binding>' }.`,
      )
    }
    super(alias, { queues: Object.keys(options.queues) })
    this.bindings = { ...options.queues }
    this.resultsOption = options.results
  }

  /** Are results written to the database? */
  get storesResults(): boolean {
    if (this.resultsOption === false) return false
    return apps.ready && apps.isInstalled('tasks')
  }

  override get supportsGetResult(): boolean {
    return this.storesResults
  }

  private producer(queueName: string): QueueProducer {
    const binding = this.bindings[queueName]
    const queue = tryGetContext()?.env?.[binding] as QueueProducer | undefined
    if (!queue || typeof queue.send !== 'function') {
      throw new ImproperlyConfigured(
        `Queue producer binding '${binding}' (queue '${queueName}') not found: add it to wrangler.jsonc "queues.producers".`,
      )
    }
    return queue
  }

  async enqueue<R>(task: Task<any, R>, args: unknown[]): Promise<TaskResult<R>> {
    const now = new Date()
    const result = this.newResult(task, args, now)
    let delaySeconds = 0
    if (result.runAfter) {
      delaySeconds = Math.max(0, Math.ceil((result.runAfter.getTime() - now.getTime()) / 1000))
      if (delaySeconds > QUEUES_MAX_DELAY_SECONDS) {
        throw new InvalidTask(
          `runAfter is ${delaySeconds}s away; Cloudflare Queues can delay a message by at most ${QUEUES_MAX_DELAY_SECONDS}s (24 hours).`,
        )
      }
    }
    const message: TaskMessage = {
      type: TASK_MESSAGE_TYPE,
      id: result.id,
      task: task.modulePath,
      args: args as JsonValue[],
      backend: this.alias,
      queueName: task.queueName,
      priority: task.priority,
      enqueuedAt: now.toISOString(),
      ...(Object.keys(result._carried).length ? { carried: result._carried } : {}),
    }
    const size = new TextEncoder().encode(JSON.stringify(message)).length
    if (size > QUEUES_MAX_MESSAGE_BYTES - 1000) {
      throw new InvalidTask(
        `The task message is ${size} bytes; Cloudflare Queues messages are limited to 128 KB. Pass ids, not data.`,
      )
    }
    const producer = this.producer(task.queueName)
    if (this.storesResults) {
      await DBTaskResult.objects.create({
        id: result.id,
        status: TaskResultStatus.READY,
        taskPath: task.modulePath,
        args,
        priority: task.priority,
        queueName: task.queueName,
        backendName: this.alias,
        maxAttempts: task.maxAttempts,
        runAfter: result.runAfter,
        carried: result._carried,
      } as any)
    }
    try {
      await producer.send(message, delaySeconds ? { delaySeconds } : undefined)
    } catch (err) {
      if (this.storesResults) await DBTaskResult.objects.filter({ pk: result.id }).delete()
      throw err
    }
    await this.enqueued(result)
    return result
  }

  override async getResult(id: string): Promise<TaskResult<any>> {
    if (!this.storesResults) return super.getResult(id)
    let row: DBTaskResult | null = null
    try {
      row = await DBTaskResult.objects.filter({ pk: id }).first()
    } catch {
      row = null
    }
    if (!row) throw new TaskResultDoesNotExist(`Task result '${id}' does not exist.`)
    return resultFromRow(row)
  }

  /**
   * Run one task message (called by the queue consumer). Acks it when the task finished (successfully or not)
   * and retries it with the task's `retryDelay` while attempts remain.
   */
  async handleMessage(msg: QueueMessageLike<TaskMessage>): Promise<void> {
    const body = msg.body
    const stored = this.storesResults
    let result: TaskResult<any>
    if (stored) {
      const row = await DBTaskResult.objects.filter({ pk: body.id }).first()
      if (row && (row.status === TaskResultStatus.SUCCESSFUL || row.status === TaskResultStatus.FAILED)) {
        msg.ack() // delivered again after it finished
        return
      }
      result = row ? resultFromRow(row) : this.resultFromMessage(body, msg)
      if (!row) {
        await DBTaskResult.objects.create({
          id: body.id,
          status: TaskResultStatus.READY,
          taskPath: body.task,
          args: body.args,
          priority: body.priority ?? 0,
          queueName: body.queueName,
          backendName: this.alias,
          maxAttempts: result.task.maxAttempts,
          carried: body.carried ?? {},
        } as any)
      }
    } else {
      result = this.resultFromMessage(body, msg)
    }
    const store = stored
      ? {
          save: async (r: TaskResult<any>) =>
            void (await DBTaskResult.objects.filter({ pk: r.id }).update(rowFields(r))),
        }
      : undefined
    const outcome = await runAttempt(this, result, { workerId: WORKER_ID, store })
    if (outcome.outcome === 'retry') {
      msg.retry({ delaySeconds: Math.min(Math.ceil(outcome.delaySeconds), QUEUES_MAX_DELAY_SECONDS) })
    } else {
      msg.ack()
    }
  }

  private resultFromMessage(body: TaskMessage, msg: QueueMessageLike<TaskMessage>): TaskResult<any> {
    const base = getTask(body.task) ?? unknownTask(body.task)
    return new TaskResult({
      id: body.id,
      task: base.using({ queueName: body.queueName, backend: this.alias, priority: body.priority ?? 0 }),
      status: TaskResultStatus.READY,
      args: body.args ?? [],
      backend: this.alias,
      enqueuedAt: body.enqueuedAt ? new Date(body.enqueuedAt) : null,
      // Queues count deliveries from 1; earlier deliveries were failed attempts.
      attempts: Math.max(0, (msg.attempts ?? 1) - 1),
      carried: body.carried ?? {},
    })
  }

  override check(): CheckMessage[] {
    if (this.resultsOption === true && !apps.isInstalled('tasks')) {
      return [
        checks.error(`cloudflareQueues({ results: true }) for '${this.alias}' needs the tasks app.`, {
          hint: "Add TasksConfig from '@ghuri/tasks' to INSTALLED_APPS and run ghuri migrate.",
          id: 'tasks.E004',
        }),
      ]
    }
    return []
  }
}

/**
 * Consume task messages from every queue (registered once, when a `cloudflareQueues()` backend is configured).
 * Messages that are not task messages are left alone for other consumers (`onQueue()`, agents).
 */
export async function consumeTaskBatch(batch: MessageBatchLike<unknown>): Promise<void> {
  // With no other consumer for this queue, a message that is not a task would be acked implicitly and lost; retry
  // it instead, as core does for a queue without handlers.
  const othersConsume = taskHandlers.queuesFor(batch.queue).some((h) => h !== consumeTaskBatch)
  for (const msg of batch.messages) {
    if (!isTaskMessage(msg.body)) {
      if (!othersConsume) {
        console.error(
          `[ghuri.tasks] queue '${batch.queue}' got a message that is not a task and has no onQueue() handler for it; retrying ${msg.id}.`,
        )
        msg.retry()
      }
      continue
    }
    const body = msg.body
    let backend: BaseTaskBackend
    try {
      backend = taskBackends.get(body.backend)
    } catch (err) {
      console.error(`[ghuri.tasks] message ${body.id} names task backend '${body.backend}':`, err)
      msg.retry()
      continue
    }
    if (!(backend instanceof CloudflareQueuesBackend)) {
      console.error(
        `[ghuri.tasks] task backend '${body.backend}' is not cloudflareQueues(); retrying ${body.id}.`,
      )
      msg.retry()
      continue
    }
    try {
      await backend.handleMessage(msg as QueueMessageLike<TaskMessage>)
    } catch (err) {
      // Storing the result failed (database down…): let Queues redeliver.
      console.error(`[ghuri.tasks] could not run ${body.task} (${body.id}):`, err)
      msg.retry()
    }
  }
}

const CONSUMER_KEY = Symbol.for('ghuri.tasks.queueConsumer')

/** @internal Register the queue consumer once per isolate. */
export function ensureQueueConsumer(): void {
  const g = globalThis as any
  if (g[CONSUMER_KEY]) return
  g[CONSUMER_KEY] = onQueue('*', consumeTaskBatch)
}

/**
 * Run tasks on Cloudflare Queues: `TASKS: { default: cloudflareQueues({ queues: { default: 'TASKS_QUEUE' } }) }`,
 * with the producer bindings and a consumer for each queue in wrangler.jsonc. Registers the queue consumer.
 */
export function cloudflareQueues(opts: CloudflareQueuesOptions): TaskBackendConfig<CloudflareQueuesBackend> {
  ensureQueueConsumer()
  return backendConfig('cloudflareQueues', (alias) => new CloudflareQueuesBackend(alias, opts))
}
