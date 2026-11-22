/** Alias of the backend tasks use unless they name another (`TASKS.default`). */
export const DEFAULT_TASK_BACKEND_ALIAS = 'default'
/** Queue tasks go to unless they name another. */
export const DEFAULT_TASK_QUEUE_NAME = 'default'
/** Priority of a task that sets none. */
export const DEFAULT_TASK_PRIORITY = 0
/** Lowest allowed priority. */
export const TASK_MIN_PRIORITY = -100
/** Highest allowed priority (larger numbers run first). */
export const TASK_MAX_PRIORITY = 100

/** `type` of the messages `cloudflareQueues()` sends; the consumer leaves other messages alone. */
export const TASK_MESSAGE_TYPE = 'ghuri.tasks.run'
/** Longest `delaySeconds` Cloudflare Queues accepts on `send()` / `retry()` (24 hours). */
export const QUEUES_MAX_DELAY_SECONDS = 86_400
/** Cloudflare Queues' message size limit (128 KB, internal metadata included). */
export const QUEUES_MAX_MESSAGE_BYTES = 128_000
/** Cloudflare Queues' default consumer `max_retries`. */
export const QUEUES_DEFAULT_MAX_RETRIES = 3
