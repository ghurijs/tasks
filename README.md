# @ghuri/tasks

Background tasks for [Ghuri](https://github.com/ghurijs/ghuri), with the API of Django 6.0's `django.tasks`:
`task()`, `.enqueue()`, `.using()`, `TaskResult`, the `TASKS` setting and the `taskEnqueued` / `taskStarted` /
`taskFinished` signals. Tasks run on **Cloudflare Queues** on Workers, from the **database** (Postgres, SQLite or
D1) with `ghuri db_worker` on Node, or **in-process** in development and tests. Ghuri adds retries, periodic
tasks and request context (the current tenant) that follows a task to its worker.

> Status: alpha (`0.1.0-alpha.0`). APIs may change. Needs `@ghuri/core` 0.1.0-alpha.5 for `ghuri db_worker --beat`
> and `serve({ scheduler: true })`.

```sh
npm install @ghuri/tasks@next
```

## Contents

1. [Quick start](#1-quick-start)
2. [Defining and enqueuing tasks](#2-defining-and-enqueuing-tasks)
3. [Results](#3-results)
4. [Backends](#4-backends)
5. [Retries](#5-retries)
6. [Periodic tasks](#6-periodic-tasks)
7. [Signals, admin and checks](#7-signals-admin-and-checks)
8. [Testing](#8-testing)
9. [Differences from Django](#9-differences-from-django)

## 1. Quick start

```ts
// src/blog/tasks.ts
import { task } from '@ghuri/tasks'
import { sendMail } from '@ghuri/mail'
import { Post } from './models'

export const notifySubscribers = task(
  async (postId: number) => {
    const post = await Post.objects.get({ pk: postId })
    await sendMail({ subject: `New post: ${post.title}`, message: post.summary, recipientList: ['team@example.com'] })
    return { notified: true }
  },
  { maxAttempts: 3 },
)
```

```ts
// src/blog/app.ts — tasks are named '<app label>.<export name>': 'blog.notifySubscribers'
import { AppConfig } from '@ghuri/core'
import * as tasks from './tasks'

export class BlogConfig extends AppConfig {
  name = 'blog'
  override tasks = tasks
}
```

```ts
// src/settings.ts
import { TasksConfig, cloudflareQueues, database } from '@ghuri/tasks'

export default defineSettings((env) => ({
  INSTALLED_APPS: [/* … */, TasksConfig, BlogConfig],
  TASKS: {
    default: env.TASKS_QUEUE
      ? cloudflareQueues({ queues: { default: 'TASKS_QUEUE' } })  // Workers
      : database(),                                                // Node + Postgres / SQLite
  },
}))
```

```ts
// a view, a signal receiver, an agent tool…
const result = await notifySubscribers.enqueue(post.pk)
```

Run `ghuri migrate` once for the `tasks_dbtaskresult` table.

## 2. Defining and enqueuing tasks

```ts
task(fn, {
  name?,          // required only for tasks not exported from an app's tasks module
  priority?,      // -100..100, larger runs first (default 0)
  queueName?,     // default 'default'
  backend?,       // TASKS alias, default 'default'
  takesContext?,  // pass TaskContext { taskResult, attempt } as the first argument
  maxAttempts?,   // Ghuri: default 1 (no retries)
  retryDelay?,    // Ghuri: seconds, or (attempt) => seconds; default 2 ** attempt, at most 1 hour
})
```

- `await t.enqueue(...args)` returns a `TaskResult`. Arguments must survive a JSON round trip unchanged; a `Date`,
  a `Map` or a model instance raises `InvalidTask`. Pass primary keys.
- `t.using({ priority, queueName, backend, runAfter })` returns a copy. `runAfter` is a `Date` or a number of
  seconds from enqueue.
- `await t.getResult(id)` loads a result (`TaskResultDoesNotExist`, `TaskResultMismatch`).
- `await t.call(...args)` runs the function now, without a backend.
- Enqueue after the data a task reads is committed: `onCommit(() => notifySubscribers.enqueue(post.pk))`.
- The request context captured at enqueue (`captureContext()` from `@ghuri/core`: the current tenant with
  `@ghuri/tenants`) is restored around every attempt. The request user is not carried; pass a user id.

## 3. Results

`TaskResult` has `id`, `task`, `status` (`READY`, `RUNNING`, `FAILED`, `SUCCESSFUL`), `args`, `backend`,
`enqueuedAt`, `startedAt`, `finishedAt`, `lastAttemptedAt`, `runAfter`, `errors` (`[{ exceptionClassPath,
traceback }]`), `workerIds`, `attempts`, `isFinished` and `returnValue` (throws `TaskResultNotReady` until
`SUCCESSFUL`). `await result.refresh()` reloads it. Return values must be JSON; anything else fails the task.

## 4. Backends

| | `immediate()` | `dummy()` | `cloudflareQueues()` | `database()` |
|---|---|---|---|---|
| Runs | inside `enqueue()` | never (tests) | the Worker's `queue()` handler | `ghuri db_worker`, or `drainTasks()` under a cron |
| `runAfter` | no | yes | up to 24 hours | yes |
| `priority` | accepted, no effect | yes | no | yes |
| `getResult()` | no | no | with the `tasks` app | yes |

`immediate()` is the default when `TASKS` is not set. Every factory takes `queues` (allowed queue names, default
`['default']`; `[]` allows any).

**Cloudflare Queues.** `cloudflareQueues({ queues: { default: 'TASKS_QUEUE', emails: 'EMAILS_QUEUE' } })` maps queue
names to producer bindings. Export the app as usual (`export default createApp(settings)`); its `queue()` handler
runs task messages and leaves other messages alone.

```jsonc
"queues": {
  "producers": [{ "binding": "TASKS_QUEUE", "queue": "mysite-tasks" }],
  "consumers": [{ "queue": "mysite-tasks", "max_retries": 5 }]
}
```

With the `tasks` app installed, results are stored in the database too (`results: false` turns that off).
Messages are limited to 128 KB and consumers get 15 minutes per batch.

**Database.** `database({ database: 'default', staleAfter: 3600 })` keeps the queue in `tasks_dbtaskresult`.
Workers claim a task with a compare-and-set `UPDATE`, so racing workers never run one task twice.

```sh
ghuri db_worker [--queue-name default,emails] [--interval 1] [--batch] [--max-tasks N] [--worker-id ID] [--beat]
ghuri prune_db_task_results [--min-age-days 14] [--queue-name …] [--only-failed] [--dry-run]
```

On Workers without Queues (and on D1), run the queue from a Cron Trigger:
`onSchedule('* * * * *', drainTasks({ seconds: 25 }))`. A task left `RUNNING` for `staleAfter` seconds lost its
worker and is retried or failed.

## 5. Retries

A task that throws is retried after `retryDelay` until `maxAttempts`; each failed attempt adds an entry to
`errors`. On Queues the message is retried with `delaySeconds`; keep the consumer's `max_retries` at least
`maxAttempts - 1` (`ghuri check` warns, `tasks.W002`). `immediate()` and `dummy().runPending()` retry at once.

## 6. Periodic tasks

```ts
ready() {
  periodicTask('0 3 * * *', cleanUpDrafts)                     // enqueue every night at 03:00 UTC
  periodicTask('*/10 * * * *', syncFeeds, { inline: true })    // or run inside the cron handler
}
```

Crons use Cloudflare's syntax in UTC: day of week is 1-7 with **1 = Sunday** (or `SUN`-`SAT`), plus `L`, `W` and
`#`. On Workers, list each cron in `triggers.crons` (`ghuri check` reports `tasks.E003`). On Node, run the scheduler
in one process: `serve(app, { scheduler: true })` or `ghuri db_worker --beat`.

## 7. Signals, admin and checks

- `taskEnqueued`, `taskStarted`, `taskFinished` (sender: the backend class, `{ taskResult }`).
  `taskFinished` is not sent for an attempt that will be retried.
- `import '@ghuri/tasks/admin'` registers a read-only `DBTaskResult` admin with "Run again" and "Mark as failed".
- `ghuri check`: `tasks.E001` bad `TASKS` entry, `tasks.E002` unknown backend or queue, `tasks.E003` periodic
  cron missing from wrangler.jsonc, `tasks.E004` a backend needs the `tasks` app, `tasks.E005` producer binding
  missing from wrangler.jsonc, `tasks.W002` consumer `max_retries` too low, `tasks.W004` queue without a consumer,
  and with `--deploy` `tasks.W001` the immediate backend.

## 8. Testing

```ts
import { captureTasks, dummy, useTaskBackend } from '@ghuri/tasks/testing'

const { backend, restore } = useTaskBackend(dummy())
await notifySubscribers.enqueue(post.pk)
expect(backend.results).toHaveLength(1)
await backend.runPending()   // run them in-process
restore()

const results = await captureTasks(() => client.post('/posts/', data))
```

## 9. Differences from Django

- Task ids are `<app label>.<export name>` (`modulePath`), filled in when apps load; `name` is the export name.
- Arguments are positional only (no kwargs); everything is `async` (`enqueue` is Django's `aenqueue`).
- `TaskError` has `exceptionClassPath` (a class name) and `traceback`.
- `returnValue` throws `TaskResultNotReady` (Django: `ValueError`); unsupported operations throw
  `NotImplementedError` from this package.
- Added: retries (`maxAttempts`, `retryDelay`), `TaskResult.runAfter`, periodic tasks, carried request context,
  `DummyBackend.runPending()`.

## License

MIT
