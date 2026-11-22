import { type CheckContext, type CheckMessage, checks } from '@ghuri/core'
import { CloudflareQueuesBackend } from './backends/cloudflare'
import { ImmediateBackend } from './backends/immediate'
import { QUEUES_DEFAULT_MAX_RETRIES } from './constants'
import { periodicTasks } from './periodic'
import { taskBackends } from './registry'
import { registeredTasks } from './task'

/** Strip `//` and `/* *\/` comments and trailing commas from JSONC, leaving strings alone. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

interface WranglerConfig {
  triggers?: { crons?: string[] }
  queues?: {
    producers?: Array<{ binding: string; queue: string }>
    consumers?: Array<{ queue: string; max_retries?: number }>
  }
}

/** wrangler.jsonc / wrangler.json in the working directory (Node only), or null. */
async function readWranglerConfig(): Promise<{ file: string; config: WranglerConfig } | null> {
  const proc = (globalThis as any).process
  if (typeof proc?.cwd !== 'function' || !proc.versions?.node) return null
  try {
    const fsSpec = 'node:fs/promises'
    const pathSpec = 'node:path'
    const fs = await import(/* @vite-ignore */ fsSpec)
    const path = await import(/* @vite-ignore */ pathSpec)
    for (const name of ['wrangler.jsonc', 'wrangler.json']) {
      const file = path.join(proc.cwd(), name)
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      return { file: name, config: parseJsonc(text) as WranglerConfig }
    }
  } catch {
    return null
  }
  return null
}

/** `tasks.*` system checks. */
export async function checkTasks(ctx: CheckContext): Promise<CheckMessage[]> {
  const messages: CheckMessage[] = []
  const setting = ctx.settings.TASKS as Record<string, unknown> | undefined
  if (setting !== undefined && (typeof setting !== 'object' || setting === null)) {
    return [checks.error('TASKS must be an object of task backends.', { id: 'tasks.E001' })]
  }
  const backendsOk = new Set<string>()
  for (const alias of taskBackends.aliases()) {
    try {
      messages.push(...taskBackends.get(alias).check())
      backendsOk.add(alias)
    } catch (err) {
      messages.push(
        checks.error((err as Error).message, {
          hint: 'Use immediate(), dummy(), database() or cloudflareQueues() from @ghuri/tasks.',
          id: 'tasks.E001',
          obj: `TASKS['${alias}']`,
        }),
      )
    }
  }

  for (const [path, t] of registeredTasks()) {
    if (!taskBackends.config(t.backend)) {
      messages.push(
        checks.error(`Task '${path}' uses the task backend '${t.backend}', which is not configured.`, {
          id: 'tasks.E002',
          obj: path,
        }),
      )
      continue
    }
    if (!backendsOk.has(t.backend)) continue
    const backend = taskBackends.get(t.backend)
    if (backend.queues.length && !backend.queues.includes(t.queueName)) {
      messages.push(
        checks.error(
          `Task '${path}' uses the queue '${t.queueName}', which is not one of backend '${t.backend}' queues (${backend.queues.join(', ')}).`,
          { id: 'tasks.E002', obj: path },
        ),
      )
    }
  }

  const wrangler = await readWranglerConfig()
  if (wrangler) messages.push(...checkWrangler(wrangler.file, wrangler.config, backendsOk))
  return messages
}

function checkWrangler(file: string, config: WranglerConfig, backendsOk: Set<string>): CheckMessage[] {
  const messages: CheckMessage[] = []
  const crons = new Set((config.triggers?.crons ?? []).map((c) => c.trim()))
  for (const p of periodicTasks()) {
    if (crons.has(p.cron.trim())) continue
    messages.push(
      checks.error(
        `The periodic task '${p.task.modulePath}' runs on '${p.cron}', which is not a Cron Trigger.`,
        {
          hint: `Add "${p.cron}" to "triggers": { "crons": [...] } in ${file}.`,
          id: 'tasks.E003',
          obj: p.task.modulePath,
        },
      ),
    )
  }

  const producers = new Map((config.queues?.producers ?? []).map((p) => [p.binding, p.queue]))
  const consumers = new Map((config.queues?.consumers ?? []).map((c) => [c.queue, c]))
  for (const alias of backendsOk) {
    const backend = taskBackends.get(alias)
    if (!(backend instanceof CloudflareQueuesBackend)) continue
    for (const [queueName, binding] of Object.entries(backend.bindings)) {
      const queue = producers.get(binding)
      if (!queue) {
        messages.push(
          checks.error(`Queue producer binding '${binding}' (task queue '${queueName}') is not in ${file}.`, {
            hint: `Add { "binding": "${binding}", "queue": "<queue name>" } to "queues.producers".`,
            id: 'tasks.E005',
            obj: `TASKS['${alias}']`,
          }),
        )
        continue
      }
      const consumer = consumers.get(queue)
      if (!consumer) {
        messages.push(
          checks.warning(`The queue '${queue}' has no consumer in ${file}; its tasks will never run.`, {
            hint: `Add { "queue": "${queue}" } to "queues.consumers".`,
            id: 'tasks.W004',
            obj: `TASKS['${alias}']`,
          }),
        )
        continue
      }
      const maxRetries = consumer.max_retries ?? QUEUES_DEFAULT_MAX_RETRIES
      for (const [path, t] of registeredTasks()) {
        if (t.backend !== alias || t.queueName !== queueName || t.maxAttempts - 1 <= maxRetries) continue
        messages.push(
          checks.warning(
            `Task '${path}' may run ${t.maxAttempts} times, but the queue '${queue}' retries a message at most ${maxRetries} times.`,
            {
              hint: `Set "max_retries": ${t.maxAttempts - 1} or more on its consumer.`,
              id: 'tasks.W002',
              obj: path,
            },
          ),
        )
      }
    }
  }
  return messages
}

/** `tasks.W001` (deploy): tasks run inside requests on the immediate backend. */
export function checkTasksDeploy(_ctx: CheckContext): CheckMessage[] {
  try {
    if (taskBackends.get() instanceof ImmediateBackend) {
      return [
        checks.warning(
          'The default task backend is immediate(): tasks run inside the request that enqueues them.',
          {
            hint: 'Use cloudflareQueues() on Workers or database() on Node in production.',
            id: 'tasks.W001',
          },
        ),
      ]
    }
  } catch {
    // reported by tasks.E001
  }
  return []
}

checks.register(checkTasks, { tags: ['tasks'] })
checks.register(checkTasksDeploy, { tags: ['tasks'], deploy: true })
