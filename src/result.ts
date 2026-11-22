import { TaskResultNotReady } from './errors'
import type { JsonValue } from './json'
import type { Task } from './task'

/** Status of a `TaskResult` (Django's `TaskResultStatus`). */
export const TaskResultStatus = {
  /** Just enqueued, or ready to be executed again (a retry). */
  READY: 'READY',
  /** Currently executing. */
  RUNNING: 'RUNNING',
  /** Raised an exception on its last attempt, or could not start. */
  FAILED: 'FAILED',
  /** Finished and returned a value. */
  SUCCESSFUL: 'SUCCESSFUL',
} as const
export type TaskResultStatus = (typeof TaskResultStatus)[keyof typeof TaskResultStatus]

/** One failed attempt (Django's `TaskError`). */
export interface TaskError {
  /** Name of the error class, e.g. `'TypeError'` (Django: the dotted path of the exception class). */
  exceptionClassPath: string
  /** The stack trace (or message) as a string. */
  traceback: string
}

/** Turn anything thrown into a `TaskError`. */
export function toTaskError(err: unknown): TaskError {
  if (err instanceof Error) {
    return {
      exceptionClassPath: err.constructor?.name || err.name || 'Error',
      traceback: err.stack ?? `${err.name}: ${err.message}`,
    }
  }
  return { exceptionClassPath: typeof err, traceback: String(err) }
}

/** Fields a backend fills in when it builds or reloads a result. */
export interface TaskResultInit<R> {
  id: string
  task: Task<any, R>
  status: TaskResultStatus
  args: JsonValue[]
  backend: string
  enqueuedAt: Date | null
  startedAt?: Date | null
  finishedAt?: Date | null
  lastAttemptedAt?: Date | null
  runAfter?: Date | null
  errors?: TaskError[]
  workerIds?: string[]
  attempts?: number
  returnValue?: R | null
  carried?: Record<string, string>
}

/**
 * The state of one enqueued task (Django's `TaskResult`). Returned by `task.enqueue()` and `task.getResult()`;
 * `refresh()` reloads it from the backend. Treat the fields as read-only: backends update them.
 */
export class TaskResult<R = unknown> {
  /** Unique id (a UUIDv7 string, shorter than 64 characters). */
  id: string
  /** The task that was enqueued (with the priority, queue, backend and `runAfter` it was enqueued with). */
  task: Task<any, R>
  status: TaskResultStatus
  /** Positional arguments (JSON). */
  args: JsonValue[]
  /** Alias of the backend (`TASKS` key). */
  backend: string
  enqueuedAt: Date | null
  /** When the first attempt started. */
  startedAt: Date | null
  finishedAt: Date | null
  /** When the most recent attempt started. */
  lastAttemptedAt: Date | null
  /** When the task may run next (deferred, or waiting to be retried). Ghuri addition. */
  runAfter: Date | null
  /** One entry per failed attempt. */
  errors: TaskError[]
  workerIds: string[]
  /** Finished attempts (a running attempt does not count). */
  attempts: number
  /** @internal */
  _returnValue: R | null
  /** @internal Captured request context (`captureContext()`), restored around every attempt. */
  _carried: Record<string, string>

  constructor(init: TaskResultInit<R>) {
    this.id = init.id
    this.task = init.task
    this.status = init.status
    this.args = init.args
    this.backend = init.backend
    this.enqueuedAt = init.enqueuedAt
    this.startedAt = init.startedAt ?? null
    this.finishedAt = init.finishedAt ?? null
    this.lastAttemptedAt = init.lastAttemptedAt ?? null
    this.runAfter = init.runAfter ?? null
    this.errors = init.errors ?? []
    this.workerIds = init.workerIds ?? []
    this.attempts = init.attempts ?? 0
    this._returnValue = init.returnValue ?? null
    this._carried = init.carried ?? {}
  }

  /** Has the task finished, successfully or not? */
  get isFinished(): boolean {
    return this.status === TaskResultStatus.SUCCESSFUL || this.status === TaskResultStatus.FAILED
  }

  /** What the task returned. Throws `TaskResultNotReady` unless the status is `SUCCESSFUL`. */
  get returnValue(): R {
    if (this.status !== TaskResultStatus.SUCCESSFUL) {
      throw new TaskResultNotReady(
        this.status === TaskResultStatus.FAILED ? 'Task failed.' : 'Task has not finished yet.',
      )
    }
    return this._returnValue as R
  }

  /** Reload every field from the backend (needs a backend with `supportsGetResult`). */
  async refresh(): Promise<void> {
    const fresh = await this.task.getResult(this.id)
    Object.assign(this, {
      status: fresh.status,
      startedAt: fresh.startedAt,
      finishedAt: fresh.finishedAt,
      lastAttemptedAt: fresh.lastAttemptedAt,
      runAfter: fresh.runAfter,
      errors: fresh.errors,
      workerIds: fresh.workerIds,
      attempts: fresh.attempts,
      _returnValue: fresh._returnValue,
    })
  }

  toString(): string {
    return `${this.task.modulePath} ${this.status} (${this.id})`
  }
}
