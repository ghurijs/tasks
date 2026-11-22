import { Signal } from '@ghuri/core'
import type { TaskResult } from './result'

/** Sent after a task is enqueued (sender: the backend class). Django's `task_enqueued`. */
export const taskEnqueued = new Signal<{ taskResult: TaskResult<any> }>('taskEnqueued')
/** Sent when an attempt starts (sender: the backend class). Django's `task_started`. */
export const taskStarted = new Signal<{ taskResult: TaskResult<any> }>('taskStarted')
/**
 * Sent when a task finishes, `SUCCESSFUL` or `FAILED` (sender: the backend class). Not sent for an attempt that
 * will be retried. Django's `task_finished`.
 */
export const taskFinished = new Signal<{ taskResult: TaskResult<any> }>('taskFinished')
