import { newWorkerId } from '../ids'
import type { TaskResult } from '../result'
import { runAttempt } from '../runner'
import type { Task } from '../task'
import { type BaseBackendOptions, BaseTaskBackend } from './base'

const WORKER_ID = newWorkerId()

/**
 * Runs tasks inside `enqueue()`, before it returns (Django's `ImmediateBackend`, the default). Errors are stored
 * on the result (`FAILED`), not thrown. Retries run at once, without waiting. Priority is accepted and has no
 * effect; `runAfter` is refused.
 */
export class ImmediateBackend extends BaseTaskBackend {
  override get supportsPriority(): boolean {
    return true
  }

  async enqueue<R>(task: Task<any, R>, args: unknown[]): Promise<TaskResult<R>> {
    const result = this.newResult(task, args)
    await this.enqueued(result)
    for (;;) {
      const { outcome } = await runAttempt(this, result, { workerId: WORKER_ID })
      if (outcome !== 'retry') break
    }
    return result
  }
}

export interface ImmediateOptions extends BaseBackendOptions {}
