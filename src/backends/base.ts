import { type CheckMessage, captureContext } from '@ghuri/core'
import { DEFAULT_TASK_PRIORITY, DEFAULT_TASK_QUEUE_NAME } from '../constants'
import { InvalidTask, NotImplementedError } from '../errors'
import { newTaskId } from '../ids'
import type { JsonValue } from '../json'
import { TaskResult, TaskResultStatus } from '../result'
import { taskEnqueued } from '../signals'
import type { Task } from '../task'

/** Options every backend factory accepts. */
export interface BaseBackendOptions {
  /** Queue names tasks may use (Django's `QUEUES`, default `['default']`; `[]` allows any). */
  queues?: string[]
}

/**
 * Base class of task backends (Django's `BaseTaskBackend`). Subclasses set the `supports*` flags and implement
 * `enqueue()` (and `getResult()` when they can look results up).
 */
export abstract class BaseTaskBackend {
  /** Can tasks be deferred with `runAfter`? */
  get supportsDefer(): boolean {
    return false
  }
  /** Can async functions be tasks? Always true in Ghuri. */
  get supportsAsyncTask(): boolean {
    return true
  }
  /** Does `getResult()` work? */
  get supportsGetResult(): boolean {
    return false
  }
  /** Is `priority` honoured? */
  get supportsPriority(): boolean {
    return false
  }
  /** Allowed queue names; empty allows any. */
  readonly queues: string[]

  constructor(
    /** The `TASKS` key. */
    readonly alias: string,
    options: BaseBackendOptions = {},
  ) {
    this.queues = options.queues ?? [DEFAULT_TASK_QUEUE_NAME]
  }

  /** Raise `InvalidTask` when this backend cannot run `task` as configured (Django's `validate_task`). */
  validateTask(task: Task<any, any>): void {
    if (!this.supportsDefer && task.runAfter !== null) {
      throw new InvalidTask('Backend does not support run_after.')
    }
    if (!this.supportsPriority && task.priority !== DEFAULT_TASK_PRIORITY) {
      throw new InvalidTask('Backend does not support setting priority of tasks.')
    }
    if (this.queues.length && !this.queues.includes(task.queueName)) {
      throw new InvalidTask(`Queue '${task.queueName}' is not valid for backend '${this.alias}'.`)
    }
  }

  /** Enqueue `task` with `args` (already validated and JSON-safe). */
  abstract enqueue<R>(task: Task<any, R>, args: unknown[]): Promise<TaskResult<R>>

  /** Load a result by id. Raises `NotImplementedError` unless `supportsGetResult`. */
  async getResult(_id: string): Promise<TaskResult<any>> {
    throw new NotImplementedError(`The ${this.constructor.name} backend does not support retrieving results.`)
  }

  /** System-check messages for this backend's configuration. */
  check(): CheckMessage[] {
    return []
  }

  /** @internal A fresh `READY` result for `task`, carrying the current request context. */
  protected newResult<R>(task: Task<any, R>, args: unknown[], now = new Date()): TaskResult<R> {
    return new TaskResult<R>({
      id: newTaskId(),
      task,
      status: TaskResultStatus.READY,
      args: args as JsonValue[],
      backend: this.alias,
      enqueuedAt: now,
      runAfter: task.resolveRunAfter(now),
      carried: captureContext(),
    })
  }

  /** @internal Send `taskEnqueued`. */
  protected async enqueued(result: TaskResult<any>): Promise<void> {
    await taskEnqueued.send(this.constructor, { taskResult: result })
  }
}
