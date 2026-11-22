import * as core from '@ghuri/core'
import { onSchedule } from '@ghuri/core'
import { InvalidTask } from './errors'
import { globalSingleton } from './global'
import { jsonProblem } from './json'
import type { Task } from './task'

export interface PeriodicTaskOptions<A extends unknown[]> {
  /** Arguments to enqueue the task with (JSON). */
  args?: A
  /** Run the task in the Cron Trigger handler (`task.call()`) instead of enqueuing it. */
  inline?: boolean
}

export interface PeriodicTask {
  cron: string
  task: Task<any, any>
  args: unknown[]
  inline: boolean
}

const periodic: PeriodicTask[] = globalSingleton('ghuri.tasks.periodic', () => [])

/**
 * Enqueue `task` on a schedule (Celery beat's job; Django has no equivalent). Call it in an `AppConfig.ready()`:
 *
 * ```ts
 * periodicTask('0 3 * * *', cleanUpDrafts)
 * ```
 *
 * The cron uses Cloudflare's syntax and runs in UTC (day of week 1-7, 1 = Sunday). On Workers, list it in
 * wrangler.jsonc `triggers.crons` (`ghuri check` reports `tasks.E003` when it is missing); on Node, start the
 * scheduler with `serve({ scheduler: true })` or `ghuri db_worker --beat`. Returns an unregister function.
 */
export function periodicTask<A extends unknown[]>(
  cron: string,
  task: Task<A, any>,
  opts: PeriodicTaskOptions<A> = {},
): () => void {
  const parse = (core as { parseCron?: (s: string) => unknown }).parseCron
  if (parse) parse(cron)
  const args = (opts.args ?? []) as unknown[]
  const problem = jsonProblem(args, 'args')
  if (problem) throw new InvalidTask(`periodicTask() arguments must be JSON: ${problem}.`)
  const entry: PeriodicTask = { cron, task, args, inline: !!opts.inline }
  periodic.push(entry)
  const off = onSchedule(cron, async () => {
    if (entry.inline) await task.call(...(args as A))
    else await task.enqueue(...(args as A))
  })
  return () => {
    off()
    const i = periodic.indexOf(entry)
    if (i >= 0) periodic.splice(i, 1)
  }
}

/** The registered periodic tasks. */
export function periodicTasks(): readonly PeriodicTask[] {
  return [...periodic]
}
