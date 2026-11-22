// Management commands: db_worker and prune_db_task_results (django-tasks' names).
import {
  type ArgumentParser,
  BaseCommand,
  CommandError,
  type CommandIO,
  type ScheduledEventLike,
  taskHandlers,
  tryGetContext,
} from '@ghuri/core'
import { asDatabaseBackend } from './backends/database'
import { DEFAULT_TASK_BACKEND_ALIAS } from './constants'
import { newWorkerId } from './ids'
import { taskBackends } from './registry'
import { TaskResultStatus } from './result'
import { runWorker } from './worker'

function list(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '' || value === '*') return null
  const names = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return names.length ? names : null
}

function positive(value: unknown, name: string, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new CommandError(`${name} must be a number >= 0.`)
  return n
}

/**
 * `ghuri db_worker` — run tasks from a `database()` backend until SIGINT/SIGTERM (django-tasks' `db_worker`).
 * `--beat` also fires Cron Triggers in this process (periodic tasks); run it in one worker only.
 */
export class DbWorkerCommand extends BaseCommand {
  static override help = 'Run tasks from the database task backend.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .option('--backend <alias>', {
        help: 'TASKS alias of a database() backend.',
        default: DEFAULT_TASK_BACKEND_ALIAS,
      })
      .option('--queue-name <names>', { help: "Comma-separated queues to run (default: all, '*')." })
      .option('--interval <seconds>', { help: 'Seconds to wait when no task is ready.', default: 1 })
      .option('--batch', { help: 'Exit when no task is ready instead of waiting.' })
      .option('--max-tasks <n>', { help: 'Exit after running this many tasks.' })
      .option('--worker-id <id>', { help: 'Id recorded on the results (default: random).' })
      .option('--beat', { help: 'Also fire Cron Triggers (periodic tasks) in this process.' })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<void> {
    const alias = String(args.backend ?? DEFAULT_TASK_BACKEND_ALIAS)
    const backend = asDatabaseBackend(taskBackends.get(alias))
    const queueNames = list(args.queueName)
    const workerId = args.workerId ? String(args.workerId) : newWorkerId()
    const controller = new AbortController()
    const proc = (globalThis as any).process
    const stop = () => {
      if (controller.signal.aborted) return
      io.stdout('Stopping after the current task…')
      controller.abort()
    }
    proc?.on?.('SIGINT', stop)
    proc?.on?.('SIGTERM', stop)

    let scheduler: { stop(): Promise<void> } | null = null
    try {
      if (args.beat) scheduler = await startBeat(io)
      io.stdout(
        io.style.success(
          `Worker ${workerId} running tasks from backend '${backend.alias}' (${queueNames ? `queues ${queueNames.join(', ')}` : 'all queues'}).`,
        ),
      )
      const { processed } = await runWorker({
        backend: alias,
        queueNames,
        workerId,
        interval: positive(args.interval, '--interval', 1),
        batch: !!args.batch,
        maxTasks: positive(args.maxTasks, '--max-tasks'),
        signal: controller.signal,
        log: (m) => io.stdout(m),
      })
      io.stdout(`Ran ${processed} task(s).`)
    } finally {
      proc?.off?.('SIGINT', stop)
      proc?.off?.('SIGTERM', stop)
      await scheduler?.stop()
    }
  }
}

async function startBeat(io: CommandIO): Promise<{ stop(): Promise<void> }> {
  const spec = '@ghuri/core/node'
  const nodeModule = (await import(/* @vite-ignore */ spec).catch(() => null)) as {
    startScheduler?: (app: unknown, opts: unknown) => Promise<{ stop(): Promise<void> }>
  } | null
  if (!nodeModule?.startScheduler) throw new CommandError('--beat needs @ghuri/core 0.1.0-alpha.5 or later.')
  const app = {
    async scheduled(event: ScheduledEventLike) {
      const ctx = tryGetContext()!
      for (const handler of taskHandlers.schedulesFor(event.cron)) await handler(event, ctx)
    },
  }
  return nodeModule.startScheduler(app, {
    onStart: (crons: string[]) =>
      io.stdout(`Firing Cron Triggers ${crons.map((c) => `'${c}'`).join(', ')} (UTC).`),
    onError: (err: unknown, cron: string) =>
      io.stderr(`Cron '${cron}' failed: ${(err as Error)?.stack ?? err}`),
  })
}

/** `ghuri prune_db_task_results` — delete finished results older than `--min-age-days` (default 14). */
export class PruneDbTaskResultsCommand extends BaseCommand {
  static override help = 'Delete finished task results from the database.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .option('--backend <alias>', {
        help: 'TASKS alias of a database() backend.',
        default: DEFAULT_TASK_BACKEND_ALIAS,
      })
      .option('--queue-name <names>', { help: 'Comma-separated queues (default: all).' })
      .option('--min-age-days <days>', { help: 'Only results finished this many days ago.', default: 14 })
      .option('--only-failed', { help: 'Only FAILED results.' })
      .option('--dry-run', { help: 'Count, do not delete.' })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<void> {
    const backend = asDatabaseBackend(taskBackends.get(String(args.backend ?? DEFAULT_TASK_BACKEND_ALIAS)))
    const days = positive(args.minAgeDays, '--min-age-days', 14)!
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const statuses = args.onlyFailed
      ? [TaskResultStatus.FAILED]
      : [TaskResultStatus.SUCCESSFUL, TaskResultStatus.FAILED]
    let qs = backend
      .objects()
      .filter({ backendName: backend.alias, status__in: statuses, finishedAt__lt: cutoff })
    const queues = list(args.queueName)
    if (queues) qs = qs.filter({ queueName__in: queues })
    if (args.dryRun) {
      io.stdout(`Would delete ${await qs.count()} task result(s).`)
      return
    }
    const [deleted] = await qs.delete()
    io.stdout(io.style.success(`Deleted ${deleted} task result(s).`))
  }
}
