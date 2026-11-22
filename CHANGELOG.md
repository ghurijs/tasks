# Changelog

## Unreleased (0.1.0-alpha.0)

- First release: Django 6.0 `django.tasks` for Ghuri. `task()`, `Task` (`using`, `enqueue`, `getResult`, `call`),
  `TaskResult`, `TaskResultStatus`, `TaskContext`, `taskBackends` / `defaultTaskBackend`, the `TASKS` setting and
  the `taskEnqueued` / `taskStarted` / `taskFinished` signals. Tasks exported from `AppConfig.tasks` are named
  `<app label>.<export name>`.
- Backends: `immediate()` (default), `dummy()` (with `runPending()`), `cloudflareQueues()` (Cloudflare Queues,
  results in the database when the `tasks` app is installed) and `database()` (Postgres, SQLite, D1).
- The `tasks` app: `DBTaskResult` (`tasks_dbtaskresult`), `ghuri db_worker` (`--beat` fires Cron Triggers on
  Node), `ghuri prune_db_task_results`, `runWorker()` and `drainTasks()` for Cron Triggers.
- Retries (`maxAttempts`, `retryDelay`), `periodicTask(cron, task)`, request context (tenant…) restored around
  every attempt, stale `RUNNING` tasks recovered.
- `@ghuri/tasks/admin`, `@ghuri/tasks/testing` (`useTaskBackend`, `captureTasks`), system checks `tasks.*`.
