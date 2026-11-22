import {
  CharField,
  DateTimeField,
  JSONField,
  type Manager,
  Model,
  PositiveIntegerField,
  SmallIntegerField,
  UUIDField,
} from '@ghuri/orm'
import { newTaskId } from './ids'
import { TaskResultStatus } from './result'

function emptyList(): unknown[] {
  return []
}

function emptyObject(): Record<string, string> {
  return {}
}

/** `DBTaskResult.status` choices. */
export const TASK_RESULT_STATUS_CHOICES: Array<[string, string]> = [
  [TaskResultStatus.READY, 'Ready'],
  [TaskResultStatus.RUNNING, 'Running'],
  [TaskResultStatus.FAILED, 'Failed'],
  [TaskResultStatus.SUCCESSFUL, 'Successful'],
]

/**
 * A stored task result (table `tasks_dbtaskresult`, django-tasks' `DBTaskResult`). The `database()` backend keeps
 * its queue here; `cloudflareQueues()` writes results here when the `tasks` app is installed.
 */
export class DBTaskResult extends Model({
  id: new UUIDField({ primaryKey: true, default: newTaskId, editable: false }),
  status: new CharField({
    maxLength: 10,
    choices: TASK_RESULT_STATUS_CHOICES,
    default: TaskResultStatus.READY,
    dbIndex: true,
  }),
  /** The task's `modulePath` (`'blog.notifySubscribers'`). */
  taskPath: new CharField({ maxLength: 255, dbIndex: true }),
  args: new JSONField({ default: emptyList, blank: true }),
  priority: new SmallIntegerField({ default: 0 }),
  queueName: new CharField({ maxLength: 100, default: 'default' }),
  backendName: new CharField({ maxLength: 100, default: 'default' }),
  /** Ghuri: attempts allowed before the result is `FAILED`. */
  maxAttempts: new PositiveIntegerField({ default: 1 }),
  attempts: new PositiveIntegerField({ default: 0 }),
  runAfter: new DateTimeField({ null: true, blank: true }),
  enqueuedAt: new DateTimeField({ autoNowAdd: true }),
  startedAt: new DateTimeField({ null: true, blank: true }),
  finishedAt: new DateTimeField({ null: true, blank: true, dbIndex: true }),
  lastAttemptedAt: new DateTimeField({ null: true, blank: true }),
  returnValue: new JSONField({ null: true, blank: true }),
  /** `[{ exceptionClassPath, traceback }]`, one per failed attempt. */
  errors: new JSONField({ default: emptyList, blank: true }),
  workerIds: new JSONField({ default: emptyList, blank: true }),
  /** Ghuri: the request context captured at enqueue (`{ tenant: '42' }`), restored around every attempt. */
  carried: new JSONField({ default: emptyObject, blank: true }),
}) {
  declare static objects: Manager<DBTaskResult>
  static Meta = {
    appLabel: 'tasks',
    ordering: ['-enqueuedAt'],
    verboseName: 'task result',
    indexes: [{ fields: ['status', 'queueName', 'priority'], name: 'tasks_dbtaskresult_ready_idx' }],
  }

  toString(): string {
    return `${this.taskPath} ${this.status} (${String(this.id)})`
  }
}
