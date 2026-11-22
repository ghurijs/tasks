// @ghuri/tasks/admin — import from your project's admin module to see task results in the admin:
//   import '@ghuri/tasks/admin'
import { action, ModelAdmin, site } from '@ghuri/admin'
import type { Context } from 'hono'
import { resultFromRow } from './backends/database'
import { DBTaskResult } from './models'
import { TaskResultStatus } from './result'

/** Enqueue a copy of each selected task with the same arguments (on the backend it was enqueued on). */
export const runAgain = action(
  { description: 'Run selected tasks again', permissions: ['change'] },
  async (admin: ModelAdmin<DBTaskResult>, c: Context, queryset: any) => {
    let n = 0
    for (const row of (await queryset) as DBTaskResult[]) {
      const result = resultFromRow(row)
      await result.task.using({ backend: row.backendName }).enqueue(...result.args)
      n++
    }
    await admin.messageUser(c, `Enqueued ${n} task(s) again.`, 'success')
  },
)

/** Mark selected `READY` / `RUNNING` tasks `FAILED` so no worker runs them. */
export const markFailed = action(
  { description: 'Mark selected tasks as failed', permissions: ['change'] },
  async (admin: ModelAdmin<DBTaskResult>, c: Context, queryset: any) => {
    const n = await queryset
      .filter({ status__in: [TaskResultStatus.READY, TaskResultStatus.RUNNING] })
      .update({ status: TaskResultStatus.FAILED, finishedAt: new Date() })
    await admin.messageUser(c, `Marked ${n} task(s) as failed.`, 'success')
  },
)

export class DBTaskResultAdmin extends ModelAdmin<DBTaskResult> {
  override listDisplay = [
    'id',
    'taskPath',
    'status',
    'queueName',
    'priority',
    'attempts',
    'enqueuedAt',
    'finishedAt',
  ]
  override listFilter = ['status', 'queueName', 'backendName']
  override searchFields = ['id', 'taskPath']
  override readonlyFields = [
    'status',
    'taskPath',
    'args',
    'priority',
    'queueName',
    'backendName',
    'maxAttempts',
    'attempts',
    'runAfter',
    'enqueuedAt',
    'startedAt',
    'finishedAt',
    'lastAttemptedAt',
    'returnValue',
    'errors',
    'workerIds',
    'carried',
  ]
  override actions = [runAgain, markFailed]

  override async hasAddPermission(_c: Context): Promise<boolean> {
    return false
  }
}

site.register(DBTaskResult, DBTaskResultAdmin)
