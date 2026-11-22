import type { ScheduledHandler } from '@ghuri/core'
import { asDatabaseBackend } from './backends/database'
import { DEFAULT_TASK_BACKEND_ALIAS } from './constants'
import { newWorkerId } from './ids'
import { taskBackends } from './registry'

export interface WorkerOptions {
  /** `TASKS` alias of a `database()` backend (default `'default'`). */
  backend?: string
  /** Only run tasks from these queues (default: every queue). */
  queueNames?: string[] | null
  /** Seconds to wait when no task is ready (default 1). */
  interval?: number
  /** Stop when no task is ready instead of waiting (django-tasks' `--batch`). */
  batch?: boolean
  /** Stop after running this many tasks. */
  maxTasks?: number
  /** Recorded in `TaskResult.workerIds` (default: random). */
  workerId?: string
  /** Stop after the current task when aborted (SIGTERM). */
  signal?: AbortSignal
  /** Stop starting new tasks after this time (epoch milliseconds). */
  deadline?: number
  /** Progress messages (default: none). */
  log?(message: string): void
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Run tasks from a `database()` backend until stopped (django-tasks' `db_worker`). Works on Node (the
 * `ghuri db_worker` command) and inside a Worker invocation (`drainTasks()`), in the current Ghuri context.
 */
export async function runWorker(opts: WorkerOptions = {}): Promise<{ processed: number; workerId: string }> {
  const backend = asDatabaseBackend(taskBackends.get(opts.backend ?? DEFAULT_TASK_BACKEND_ALIAS))
  const workerId = opts.workerId ?? newWorkerId()
  const interval = Math.max(0, opts.interval ?? 1) * 1000
  const log = opts.log ?? (() => {})
  let processed = 0
  let lastRecovery = 0
  for (;;) {
    if (opts.signal?.aborted) break
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    if (Date.now() - lastRecovery > 60_000) {
      lastRecovery = Date.now()
      const recovered = await backend.recoverStale()
      if (recovered) log(`Recovered ${recovered} task(s) whose worker stopped.`)
    }
    const result = await backend.runNext({ workerId, queueNames: opts.queueNames })
    if (result) {
      processed++
      log(`${result.task.modulePath} ${result.id} ${result.status}`)
      if (opts.maxTasks !== undefined && processed >= opts.maxTasks) break
      continue
    }
    if (opts.batch) break
    await sleep(interval, opts.signal)
  }
  return { processed, workerId }
}

export interface DrainOptions extends Pick<WorkerOptions, 'backend' | 'queueNames' | 'log'> {
  /** Stop starting tasks after this many seconds (default 25). */
  seconds?: number
}

/**
 * A Cron Trigger handler that runs ready `database()` tasks for up to `seconds`, then returns: background tasks
 * on Workers without Queues (and on D1). `onSchedule('* * * * *', drainTasks())`.
 */
export function drainTasks(opts: DrainOptions = {}): ScheduledHandler {
  return async () => {
    await runWorker({ ...opts, batch: true, deadline: Date.now() + (opts.seconds ?? 25) * 1000 })
  }
}
