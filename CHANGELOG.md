# Changelog

## 0.1.0-alpha.1

- **Fix:** a Worker that imports `@ghuri/tasks` did not start on Cloudflare: the `immediate`, `dummy` and
  `cloudflareQueues` backends made their worker id with `crypto.getRandomValues()` while their modules loaded, and
  workerd forbids random values at global scope ("Disallowed operation called within global scope"). This broke
  every Workers project with `TasksConfig` installed (`npm create ghuri` projects included). The id is now made on
  first use, one per isolate.
- tests: `test/workerd.test.ts` bundles a project with `@ghuri/tasks` and runs it in workerd (Miniflare) on D1, with
  a real Cloudflare Queue producer and consumer: a task enqueued in a request runs in the app's `queue()` handler,
  and `immediate()` runs inside a request.

## 0.1.0-alpha.0

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
- `globalThis[Symbol.for('ghuri.tasks.interop')]` (`TasksInterop`: `{ version: 1, task, getTask }`, key
  `TASKS_INTEROP_KEY`) lets packages that do not depend on `@ghuri/tasks` define and find tasks. `@ghuri/agents` uses
  it for `agents.run`.
