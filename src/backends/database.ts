import { apps, type CheckMessage, checks, ImproperlyConfigured } from '@ghuri/core'
import { Q } from '@ghuri/orm'
import { InvalidTaskBackend, TaskResultDoesNotExist } from '../errors'
import type { JsonValue } from '../json'
import { DBTaskResult } from '../models'
import { backendConfig, type TaskBackendConfig } from '../registry'
import { type TaskError, TaskResult, TaskResultStatus } from '../result'
import { type AttemptStore, runAttempt } from '../runner'
import { taskFinished } from '../signals'
import { getTask, retryDelaySeconds, Task, type TaskDefinition } from '../task'
import { type BaseBackendOptions, BaseTaskBackend } from './base'

export interface DatabaseOptions extends BaseBackendOptions {
  /** `DATABASES` alias holding the `tasks_dbtaskresult` table (default `'default'`). */
  database?: string
  /** Seconds after which a `RUNNING` task whose worker went away is retried or failed (default 3600). */
  staleAfter?: number
}

/** @internal A stand-in for a task that is not registered in this process (renamed, or its app is not installed). */
export function unknownTask(path: string): Task<any, any> {
  const def: TaskDefinition = {
    fn: () => {
      throw new ImproperlyConfigured(
        `Task '${path}' is not registered in this process: is its app installed with tasks = tasks?`,
      )
    },
    modulePath: path,
    explicitName: true,
    takesContext: false,
    maxAttempts: 1,
    retryDelay: 0,
  }
  return new Task(def)
}

/** @internal Build a `TaskResult` from a stored row. */
export function resultFromRow(row: DBTaskResult): TaskResult<any> {
  const base = getTask(row.taskPath) ?? unknownTask(row.taskPath)
  const t = base.using({
    priority: row.priority,
    queueName: row.queueName,
    backend: row.backendName,
    runAfter: null,
  })
  return new TaskResult({
    id: String(row.id),
    task: t,
    status: row.status as TaskResultStatus,
    args: (row.args ?? []) as JsonValue[],
    backend: row.backendName,
    enqueuedAt: row.enqueuedAt ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    lastAttemptedAt: row.lastAttemptedAt ?? null,
    runAfter: row.runAfter ?? null,
    errors: (row.errors ?? []) as TaskError[],
    workerIds: (row.workerIds ?? []) as string[],
    attempts: row.attempts ?? 0,
    returnValue: row.returnValue ?? null,
    carried: (row.carried ?? {}) as Record<string, string>,
  })
}

/** @internal The row columns an attempt changes. */
export function rowFields(result: TaskResult<any>): Record<string, unknown> {
  return {
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    lastAttemptedAt: result.lastAttemptedAt,
    runAfter: result.runAfter,
    attempts: result.attempts,
    returnValue: result._returnValue,
    errors: result.errors,
    workerIds: result.workerIds,
  }
}

/** @internal Raise unless the `tasks` app (and so its table) is installed. */
export function requireTasksApp(what: string): void {
  if (!apps.ready || !apps.isInstalled('tasks')) {
    throw new ImproperlyConfigured(
      `${what} needs the tasks app: add TasksConfig to INSTALLED_APPS and run migrate.`,
    )
  }
}

/**
 * Keeps tasks in the `tasks_dbtaskresult` table of any database (django-tasks' `DatabaseBackend`): Postgres,
 * SQLite or D1. Run them with `ghuri db_worker` on Node, or with `drainTasks()` under a Cron Trigger on Workers.
 */
export class DatabaseBackend extends BaseTaskBackend {
  override get supportsDefer(): boolean {
    return true
  }
  override get supportsPriority(): boolean {
    return true
  }
  override get supportsGetResult(): boolean {
    return true
  }
  /** `DATABASES` alias. */
  readonly database: string
  readonly staleAfter: number

  constructor(alias: string, options: DatabaseOptions = {}) {
    super(alias, options)
    this.database = options.database ?? 'default'
    this.staleAfter = options.staleAfter ?? 3600
  }

  /** @internal */
  objects() {
    requireTasksApp(`The database task backend '${this.alias}'`)
    return DBTaskResult.objects.using(this.database)
  }

  async enqueue<R>(task: Task<any, R>, args: unknown[]): Promise<TaskResult<R>> {
    const result = this.newResult(task, args)
    const row = await this.objects().create({
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
    result.enqueuedAt = row.enqueuedAt ?? result.enqueuedAt
    await this.enqueued(result)
    return result
  }

  override async getResult(id: string): Promise<TaskResult<any>> {
    let row: DBTaskResult | null = null
    try {
      row = await this.objects().filter({ pk: id }).first()
    } catch (err) {
      if (err instanceof ImproperlyConfigured) throw err
      row = null // not a UUID (Postgres refuses to compare it)
    }
    if (!row) throw new TaskResultDoesNotExist(`Task result '${id}' does not exist.`)
    return resultFromRow(row)
  }

  /** @internal Persist an attempt's changes. */
  readonly store: AttemptStore = {
    save: async (result) => {
      await this.objects().filter({ pk: result.id }).update(rowFields(result))
    },
  }

  /**
   * Claim the next ready task (highest priority, then oldest) for `workerId`. The claim is a compare-and-set
   * (`UPDATE … WHERE status = 'READY'`), so concurrent workers never run the same task. Returns null when no
   * task is ready.
   */
  async claim(opts: {
    workerId: string
    queueNames?: string[] | null
    now?: Date
  }): Promise<TaskResult<any> | null> {
    for (let tries = 0; tries < 10; tries++) {
      const now = opts.now ?? new Date()
      let qs = this.objects()
        .filter({ status: TaskResultStatus.READY, backendName: this.alias })
        .filter(Q({ runAfter__isnull: true }).or({ runAfter__lte: now }))
      if (opts.queueNames?.length) qs = qs.filter({ queueName__in: opts.queueNames })
      const row = await qs.orderBy('-priority', 'enqueuedAt', 'id').first()
      if (!row) return null
      const claimed = await this.objects()
        .filter({ pk: row.pk, status: TaskResultStatus.READY })
        .update({ status: TaskResultStatus.RUNNING, lastAttemptedAt: now })
      if (claimed === 1) return resultFromRow(row)
    }
    return null
  }

  /** Claim and run the next ready task. Returns its result, or null when no task was ready. */
  async runNext(opts: { workerId: string; queueNames?: string[] | null }): Promise<TaskResult<any> | null> {
    const result = await this.claim(opts)
    if (!result) return null
    await runAttempt(this, result, { workerId: opts.workerId, store: this.store })
    return result
  }

  /**
   * Tasks left `RUNNING` for longer than `staleAfter` seconds lost their worker (a crash, a deploy): count the
   * attempt as failed, then retry or fail them. Returns how many were recovered.
   */
  async recoverStale(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.staleAfter * 1000)
    const rows = await this.objects()
      .filter({ status: TaskResultStatus.RUNNING, backendName: this.alias, lastAttemptedAt__lt: cutoff })
      .fetch()
    let recovered = 0
    for (const row of rows) {
      const result = resultFromRow(row)
      result.attempts += 1
      result.errors = [
        ...result.errors,
        {
          exceptionClassPath: 'WorkerLost',
          traceback: `The worker stopped responding during attempt ${result.attempts} (running since ${row.lastAttemptedAt?.toISOString()}).`,
        },
      ]
      const retry = result.attempts < result.task.maxAttempts
      result.status = retry ? TaskResultStatus.READY : TaskResultStatus.FAILED
      result.runAfter = retry
        ? new Date(now.getTime() + retryDelaySeconds(result.task, result.attempts) * 1000)
        : null
      if (!retry) result.finishedAt = now
      const n = await this.objects()
        .filter({ pk: row.pk, status: TaskResultStatus.RUNNING })
        .update(rowFields(result))
      if (n !== 1) continue
      recovered++
      if (!retry) await taskFinished.send(this.constructor, { taskResult: result })
    }
    return recovered
  }

  override check(): CheckMessage[] {
    if (!apps.isInstalled('tasks')) {
      return [
        checks.error(`The database task backend '${this.alias}' needs the tasks app.`, {
          hint: "Add TasksConfig from '@ghuri/tasks' to INSTALLED_APPS and run ghuri migrate.",
          id: 'tasks.E004',
        }),
      ]
    }
    return []
  }
}

/** @internal The `DatabaseBackend` for `alias`, or `InvalidTaskBackend`. */
export function asDatabaseBackend(backend: BaseTaskBackend): DatabaseBackend {
  if (!(backend instanceof DatabaseBackend)) {
    throw new InvalidTaskBackend(
      `The task backend '${backend.alias}' is a ${backend.constructor.name}; db_worker needs database().`,
    )
  }
  return backend
}

/**
 * Keep tasks in the database (django-tasks' `DatabaseBackend`): `TASKS: { default: database() }`. Needs the
 * `tasks` app. Run the tasks with `ghuri db_worker` (Node) or `drainTasks()` under a Cron Trigger (Workers).
 */
export function database(opts: DatabaseOptions = {}): TaskBackendConfig<DatabaseBackend> {
  return backendConfig('database', (alias) => new DatabaseBackend(alias, opts))
}
