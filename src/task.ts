import { apps, ImproperlyConfigured } from '@ghuri/core'
import type { BaseTaskBackend } from './backends/base'
import {
  DEFAULT_TASK_BACKEND_ALIAS,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_TASK_QUEUE_NAME,
  TASK_MAX_PRIORITY,
  TASK_MIN_PRIORITY,
} from './constants'
import { InvalidTask, TaskResultMismatch } from './errors'
import { globalSingleton } from './global'
import { jsonProblem } from './json'
import { taskBackends } from './registry'
import type { TaskResult } from './result'

/** When a deferred task may run: a `Date`, or a number of seconds after it is enqueued (Django: a timedelta). */
export type RunAfter = Date | number

export interface TaskOptions {
  /**
   * The task's id (Django's `module_path`). Tasks exported from an app's `tasks` module are named
   * `<app label>.<export name>` automatically; others must pass a name.
   */
  name?: string
  /** -100 to 100, larger runs first (default 0). Needs a backend with `supportsPriority`. */
  priority?: number
  /** Default `'default'`. Must be one of the backend's queues. */
  queueName?: string
  /** `TASKS` alias (default `'default'`). */
  backend?: string
  /** Pass a `TaskContext` (`{ taskResult, attempt }`) as the first argument. */
  takesContext?: boolean
  /** Ghuri: how many times to try before the result is `FAILED` (default 1: no retries, as in Django). */
  maxAttempts?: number
  /** Ghuri: seconds before retry number `attempt` (default `2 ** attempt`, at most one hour). */
  retryDelay?: number | ((attempt: number) => number)
}

/** Overrides for `task.using()`. */
export interface TaskOverrides {
  priority?: number
  queueName?: string
  backend?: string
  runAfter?: RunAfter | null
}

/** @internal What `task()` was given, shared by every `using()` copy. */
export interface TaskDefinition {
  fn: (...args: any[]) => unknown
  modulePath?: string
  explicitName: boolean
  takesContext: boolean
  maxAttempts: number
  retryDelay: number | ((attempt: number) => number)
}

/** Passed as the first argument to tasks defined with `takesContext: true`. */
export class TaskContext<R = unknown> {
  constructor(
    /** The result of the running task. */
    readonly taskResult: TaskResult<R>,
    /** The current attempt, starting at 1. */
    readonly attempt: number,
  ) {
    Object.freeze(this)
  }
}

const BRAND = Symbol.for('ghuri.tasks.Task')
const registry: Map<string, Task<any, any>> = globalSingleton('ghuri.tasks.registry', () => new Map())

function checkPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < TASK_MIN_PRIORITY || priority > TASK_MAX_PRIORITY) {
    throw new InvalidTask(
      `priority must be a whole number between ${TASK_MIN_PRIORITY} and ${TASK_MAX_PRIORITY}.`,
    )
  }
  return priority
}

function checkQueueName(queueName: string): string {
  if (typeof queueName !== 'string' || !queueName)
    throw new InvalidTask('queueName must be a non-empty string.')
  return queueName
}

function checkRunAfter(runAfter: RunAfter | null): RunAfter | null {
  if (runAfter === null) return null
  if (runAfter instanceof Date) {
    if (Number.isNaN(runAfter.getTime())) throw new InvalidTask('runAfter is an invalid Date.')
    return runAfter
  }
  if (typeof runAfter !== 'number' || !Number.isFinite(runAfter) || runAfter < 0) {
    throw new InvalidTask('runAfter must be a Date or a number of seconds (>= 0).')
  }
  return runAfter
}

/**
 * A background task (Django's `Task`), created with `task()`. Its options are fixed; `using()` returns a copy
 * with other ones.
 */
export class Task<A extends unknown[] = any[], R = unknown> {
  readonly [BRAND] = true
  /** @internal */
  readonly def: TaskDefinition
  readonly priority: number
  readonly queueName: string
  readonly backend: string
  readonly runAfter: RunAfter | null

  /** @internal Use `task()`. */
  constructor(def: TaskDefinition, overrides: TaskOverrides = {}) {
    this.def = def
    this.priority = checkPriority(overrides.priority ?? DEFAULT_TASK_PRIORITY)
    this.queueName = checkQueueName(overrides.queueName ?? DEFAULT_TASK_QUEUE_NAME)
    this.backend = overrides.backend ?? DEFAULT_TASK_BACKEND_ALIAS
    this.runAfter = checkRunAfter(overrides.runAfter ?? null)
    Object.freeze(this)
  }

  /** The task's id, `'<app label>.<export name>'` (Django's `module_path`); `''` until it is named. */
  get modulePath(): string {
    return this.def.modulePath ?? ''
  }

  /** The function's name (`notifySubscribers`); not necessarily unique. */
  get name(): string {
    const path = this.def.modulePath
    return path ? path.slice(path.lastIndexOf('.') + 1) : this.def.fn.name
  }

  /** The function the task runs. */
  get func(): (...args: any[]) => unknown {
    return this.def.fn
  }

  get takesContext(): boolean {
    return this.def.takesContext
  }

  get maxAttempts(): number {
    return this.def.maxAttempts
  }

  /** A copy of this task with other options. */
  using(overrides: TaskOverrides = {}): Task<A, R> {
    return new Task<A, R>(this.def, {
      priority: overrides.priority ?? this.priority,
      queueName: overrides.queueName ?? this.queueName,
      backend: overrides.backend ?? this.backend,
      runAfter: overrides.runAfter === undefined ? this.runAfter : overrides.runAfter,
    })
  }

  /** The backend this task is enqueued on. */
  getBackend(): BaseTaskBackend {
    return taskBackends.get(this.backend)
  }

  /**
   * Enqueue the task (Django's `enqueue` and `aenqueue`). Arguments must survive a JSON round trip unchanged:
   * pass primary keys, not model instances. Raises `InvalidTask` if the backend cannot run it.
   */
  async enqueue(...args: A): Promise<TaskResult<R>> {
    if (!this.def.modulePath) {
      throw new InvalidTask(
        `Task '${this.def.fn.name || 'anonymous'}' has no name: export it from an app's tasks module (AppConfig.tasks) or pass task(fn, { name }).`,
      )
    }
    const problem = jsonProblem(args, 'args')
    if (problem) throw new InvalidTask(`Task arguments must be JSON: ${problem}.`)
    const backend = this.getBackend()
    backend.validateTask(this)
    return backend.enqueue(this, args as unknown[]) as Promise<TaskResult<R>>
  }

  /**
   * Load a result by id (Django's `get_result` / `aget_result`). Raises `TaskResultDoesNotExist`,
   * `TaskResultMismatch` when the id belongs to another task, or `NotImplementedError` when the backend cannot
   * look results up.
   */
  async getResult(id: string): Promise<TaskResult<R>> {
    const result = await this.getBackend().getResult(id)
    if (result.task.modulePath !== this.modulePath) {
      throw new TaskResultMismatch(
        `Task does not match (received '${result.task.modulePath}', expected '${this.modulePath}').`,
      )
    }
    return result as TaskResult<R>
  }

  /** Run the function now, in this process, without a backend (Django's `call`). */
  async call(...args: A): Promise<R> {
    if (this.def.takesContext) {
      throw new InvalidTask(
        'call() cannot pass a TaskContext; enqueue the task on the immediate() backend instead.',
      )
    }
    return (await this.def.fn(...args)) as R
  }

  /** @internal The time `runAfter` means for a task enqueued at `now`. */
  resolveRunAfter(now: Date = new Date()): Date | null {
    if (this.runAfter === null) return null
    if (this.runAfter instanceof Date) return this.runAfter
    return new Date(now.getTime() + this.runAfter * 1000)
  }

  toString(): string {
    return `<Task ${this.modulePath || this.def.fn.name || 'anonymous'}>`
  }
}

/** Is `value` a `Task` (from any copy of this package)? */
export function isTask(value: unknown): value is Task<any, any> {
  return typeof value === 'object' && value !== null && (value as any)[BRAND] === true
}

/**
 * Define a background task (Django's `@task`):
 *
 * ```ts
 * export const sendWelcome = task(async (userId: number) => { … }, { queueName: 'emails', maxAttempts: 3 })
 * await sendWelcome.enqueue(user.pk)
 * ```
 */
export function task<A extends unknown[], R>(
  fn: (context: TaskContext<Awaited<R>>, ...args: A) => R,
  options: TaskOptions & { takesContext: true },
): Task<A, Awaited<R>>
export function task<A extends unknown[], R>(
  fn: (...args: A) => R,
  options?: TaskOptions & { takesContext?: false },
): Task<A, Awaited<R>>
export function task(fn: (...args: any[]) => unknown, options: TaskOptions = {}): Task<any[], any> {
  if (typeof fn !== 'function') throw new InvalidTask('task() expects a function.')
  const maxAttempts = options.maxAttempts ?? 1
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new InvalidTask('maxAttempts must be 1 or more.')
  const retryDelay = options.retryDelay ?? defaultRetryDelay
  if (typeof retryDelay === 'number' && (!Number.isFinite(retryDelay) || retryDelay < 0)) {
    throw new InvalidTask('retryDelay must be a number of seconds (>= 0) or a function.')
  }
  const def: TaskDefinition = {
    fn,
    modulePath: options.name,
    explicitName: !!options.name,
    takesContext: !!options.takesContext,
    maxAttempts,
    retryDelay,
  }
  const t = new Task(def, {
    priority: options.priority,
    queueName: options.queueName,
    backend: options.backend,
  })
  if (options.name) registry.set(options.name, t)
  return t
}

/** `2 ** attempt` seconds, at most one hour. */
export function defaultRetryDelay(attempt: number): number {
  return Math.min(2 ** attempt, 3600)
}

/** @internal Seconds to wait before retrying after failed attempt number `attempt`. */
export function retryDelaySeconds(t: Task<any, any>, attempt: number): number {
  const d = t.def.retryDelay
  const seconds = typeof d === 'function' ? d(attempt) : d
  return Math.max(0, Number.isFinite(seconds) ? seconds : 0)
}

/** The registered task called `modulePath`, or undefined. */
export function getTask(modulePath: string): Task<any, any> | undefined {
  return registry.get(modulePath)
}

/** Every registered task, by `modulePath`. */
export function registeredTasks(): Map<string, Task<any, any>> {
  return new Map(registry)
}

/** @internal Register `t` under `modulePath` (app tasks get their names at `apps.populate()`). */
export function registerTask(t: Task<any, any>, modulePath: string): void {
  t.def.modulePath = modulePath
  registry.set(modulePath, t)
}

// Name the tasks of every installed app: `AppConfig.tasks = tasks` (`import * as tasks from './tasks'`).
const HOOK_KEY = Symbol.for('ghuri.tasks.populateHook')
if (!(globalThis as any)[HOOK_KEY]) {
  ;(globalThis as any)[HOOK_KEY] = true
  apps.onPopulate((registryOfApps: any) => {
    const seen = new Map<string, TaskDefinition>()
    for (const config of registryOfApps.getAppConfigs()) {
      const mod = (config as { tasks?: Record<string, unknown> }).tasks
      if (!mod) continue
      for (const [exportName, value] of Object.entries(mod)) {
        if (!isTask(value)) continue
        const path = value.def.explicitName ? value.def.modulePath! : `${config.appLabel}.${exportName}`
        const other = seen.get(path)
        if (other && other !== value.def) {
          throw new ImproperlyConfigured(
            `Two tasks are named '${path}'; pass task(fn, { name }) to rename one.`,
          )
        }
        seen.set(path, value.def)
        // A task re-exported from a second app keeps the name it got first.
        if (!value.def.explicitName && value.def.modulePath && seen.get(value.def.modulePath) === value.def)
          continue
        registerTask(value, path)
      }
    }
  })
}
