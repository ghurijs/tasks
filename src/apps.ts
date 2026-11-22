import { AppConfig } from '@ghuri/core'
import { DbWorkerCommand, PruneDbTaskResultsCommand } from './commands'
import * as tasksMigrations from './migrations/index'
import { DBTaskResult } from './models'

/** `path` when running from the TypeScript sources (makemigrations), undefined in dist / on Workers. */
function appPath(): string | undefined {
  const meta = import.meta as ImportMeta & { dirname?: string; filename?: string }
  if (!meta.dirname || !/[\\/]src$/.test(meta.dirname) || !/\.[cm]?ts$/.test(meta.filename ?? ''))
    return undefined
  return meta.dirname
}

/**
 * The `tasks` app: the `DBTaskResult` table (`tasks_dbtaskresult`) used by the `database()` backend and for
 * Cloudflare Queues results, and the `db_worker` / `prune_db_task_results` commands. Add it to
 * `INSTALLED_APPS` and run `ghuri migrate`.
 */
export class TasksConfig extends AppConfig {
  name = '@ghuri/tasks'
  override label = 'tasks'
  override verboseName = 'Tasks'
  override path = appPath()
  override migrations = tasksMigrations
  override models = { DBTaskResult }
  override commands = { db_worker: DbWorkerCommand, prune_db_task_results: PruneDbTaskResultsCommand }
}
