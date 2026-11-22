import { restoreContext } from '@ghuri/core'
import type { BaseTaskBackend } from './backends/base'
import { jsonProblem } from './json'
import { type TaskResult, TaskResultStatus, toTaskError } from './result'
import { taskFinished, taskStarted } from './signals'
import { retryDelaySeconds, TaskContext } from './task'

export type AttemptOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed' }
  | { outcome: 'retry'; delaySeconds: number }

/** How a backend persists a result while an attempt runs. */
export interface AttemptStore {
  /** Called after the result changed: `'started'`, then `'finished'` or `'retry'`. */
  save(result: TaskResult<any>, phase: 'started' | 'finished' | 'retry'): Promise<void>
}

const noStore: AttemptStore = { save: async () => {} }

/**
 * Run one attempt of `result`'s task with Django's lifecycle: `RUNNING` + `taskStarted`, then `SUCCESSFUL` or
 * `FAILED` + `taskFinished`, or back to `READY` (with `runAfter` set) when attempts remain. The request context
 * captured at enqueue (tenant, …) is restored around the function. Errors thrown by the task are recorded,
 * never rethrown; errors from `store.save` are.
 */
export async function runAttempt(
  backend: BaseTaskBackend,
  result: TaskResult<any>,
  opts: { workerId: string; store?: AttemptStore },
): Promise<AttemptOutcome> {
  const store = opts.store ?? noStore
  const t = result.task
  const attempt = result.attempts + 1
  const started = new Date()
  result.status = TaskResultStatus.RUNNING
  result.startedAt ??= started
  result.lastAttemptedAt = started
  result.runAfter = null
  if (!result.workerIds.includes(opts.workerId)) result.workerIds = [...result.workerIds, opts.workerId]
  await store.save(result, 'started')
  await taskStarted.send(backend.constructor, { taskResult: result })

  let value: unknown
  let error: unknown
  let ok = false
  try {
    value = await restoreContext(result._carried, async () =>
      t.def.takesContext
        ? t.def.fn(new TaskContext(result, attempt), ...result.args)
        : t.def.fn(...result.args),
    )
    if (value === undefined) value = null
    const problem = jsonProblem(value, 'the return value')
    if (problem) throw new TypeError(`Task return values must be JSON: ${problem}.`)
    ok = true
  } catch (err) {
    error = err
  }

  const now = new Date()
  result.attempts = attempt
  if (ok) {
    result.status = TaskResultStatus.SUCCESSFUL
    result._returnValue = value
    result.finishedAt = now
    await store.save(result, 'finished')
    await taskFinished.send(backend.constructor, { taskResult: result })
    return { outcome: 'succeeded' }
  }

  result.errors = [...result.errors, toTaskError(error)]
  if (attempt < t.def.maxAttempts) {
    const delaySeconds = retryDelaySeconds(t, attempt)
    result.status = TaskResultStatus.READY
    result.runAfter = new Date(now.getTime() + delaySeconds * 1000)
    await store.save(result, 'retry')
    console.warn(
      `[ghuri.tasks] ${t.modulePath} (${result.id}) attempt ${attempt}/${t.def.maxAttempts} failed; retrying in ${delaySeconds}s:`,
      error,
    )
    return { outcome: 'retry', delaySeconds }
  }
  result.status = TaskResultStatus.FAILED
  result.finishedAt = now
  await store.save(result, 'finished')
  console.error(`[ghuri.tasks] ${t.modulePath} (${result.id}) failed:`, error)
  await taskFinished.send(backend.constructor, { taskResult: result })
  return { outcome: 'failed' }
}
