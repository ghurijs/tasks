// @ghuri/tasks/testing — test helpers (Django tests swap TASKS for the DummyBackend).
import type { BaseTaskBackend } from './backends/base'
import { DEFAULT_TASK_BACKEND_ALIAS } from './constants'
import { type TaskBackendConfig, taskBackends } from './registry'
import type { TaskResult } from './result'
import { taskEnqueued } from './signals'

export { DummyBackend } from './backends/dummy'
export { ImmediateBackend } from './backends/immediate'
export { dummy, immediate } from './registry'

/**
 * Use `config` for `alias` (default `'default'`) until `restore()`, whatever `TASKS` says:
 *
 * ```ts
 * const { backend, restore } = useTaskBackend(dummy())
 * await sendWelcome.enqueue(user.pk)
 * expect(backend.results).toHaveLength(1)
 * await backend.runPending()
 * restore()
 * ```
 */
export function useTaskBackend<B extends BaseTaskBackend>(
  config: TaskBackendConfig<B>,
  alias: string = DEFAULT_TASK_BACKEND_ALIAS,
): { backend: B; restore(): void } {
  const restore = taskBackends.override(alias, config)
  return { backend: config.create(alias), restore }
}

/** Run `fn` and return the results of every task enqueued meanwhile (on any backend). */
export async function captureTasks(fn: () => unknown | Promise<unknown>): Promise<TaskResult<any>[]> {
  const captured: TaskResult<any>[] = []
  const receiver = ({ taskResult }: { taskResult: TaskResult<any> }) => {
    captured.push(taskResult)
  }
  taskEnqueued.connect(receiver)
  try {
    await fn()
  } finally {
    taskEnqueued.disconnect(receiver)
  }
  return captured
}
