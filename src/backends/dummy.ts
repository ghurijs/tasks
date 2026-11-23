import { isolateWorkerId } from '../ids'
import { type TaskResult, TaskResultStatus } from '../result'
import { runAttempt } from '../runner'
import type { Task } from '../task'
import { type BaseBackendOptions, BaseTaskBackend } from './base'

/**
 * Stores enqueued tasks and never runs them (Django's `DummyBackend`), for tests: inspect `results`, `clear()`
 * them, or (Ghuri) `runPending()` to run them in-process.
 */
export class DummyBackend extends BaseTaskBackend {
  override get supportsDefer(): boolean {
    return true
  }
  override get supportsPriority(): boolean {
    return true
  }
  /** Results of the enqueued tasks, in the order they were enqueued. */
  readonly results: TaskResult<any>[] = []

  async enqueue<R>(task: Task<any, R>, args: unknown[]): Promise<TaskResult<R>> {
    const result = this.newResult(task, args)
    this.results.push(result)
    await this.enqueued(result)
    return result
  }

  /** Forget the stored results. */
  clear(): void {
    this.results.length = 0
  }

  /**
   * Ghuri: run every `READY` result in-process, in enqueue order, ignoring `runAfter` (retries run at once), with
   * the request context each one was enqueued with. Tasks enqueued while this runs are run too. Returns how many
   * results finished.
   */
  async runPending(): Promise<number> {
    let finished = 0
    for (let i = 0; i < this.results.length; i++) {
      const result = this.results[i]
      while (result.status === TaskResultStatus.READY) {
        const { outcome } = await runAttempt(this, result, { workerId: isolateWorkerId() })
        if (outcome !== 'retry') finished++
      }
    }
    return finished
  }
}

export interface DummyOptions extends BaseBackendOptions {}
