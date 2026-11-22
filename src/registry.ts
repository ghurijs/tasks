import { tryGetContext } from '@ghuri/core'
import type { BaseTaskBackend } from './backends/base'
import { DummyBackend, type DummyOptions } from './backends/dummy'
import { ImmediateBackend, type ImmediateOptions } from './backends/immediate'
import { DEFAULT_TASK_BACKEND_ALIAS } from './constants'
import { InvalidTaskBackend } from './errors'
import { globalSingleton } from './global'

/**
 * An entry of the `TASKS` setting, made by a factory (`immediate()`, `dummy()`, `database()`,
 * `cloudflareQueues()`), like `CACHES` entries. One backend instance is created per alias and kept.
 */
export interface TaskBackendConfig<B extends BaseTaskBackend = BaseTaskBackend> {
  /** Backend name for messages and checks, e.g. `'cloudflareQueues'`. */
  readonly backend: string
  create(alias: string): B
}

/** @internal Build a config whose backend instances are created once per alias. */
export function backendConfig<B extends BaseTaskBackend>(
  backend: string,
  make: (alias: string) => B,
): TaskBackendConfig<B> {
  const instances = new Map<string, B>()
  return {
    backend,
    create(alias: string): B {
      let b = instances.get(alias)
      if (!b) {
        b = make(alias)
        instances.set(alias, b)
      }
      return b
    },
  }
}

/** Run tasks inside `enqueue()` (Django's `ImmediateBackend`; the default when `TASKS` is not set). */
export function immediate(opts: ImmediateOptions = {}): TaskBackendConfig<ImmediateBackend> {
  return backendConfig('immediate', (alias) => new ImmediateBackend(alias, opts))
}

/** Store tasks without running them, for tests (Django's `DummyBackend`). */
export function dummy(opts: DummyOptions = {}): TaskBackendConfig<DummyBackend> {
  return backendConfig('dummy', (alias) => new DummyBackend(alias, opts))
}

const DEFAULT_CONFIG = immediate()
const overrides: Map<string, TaskBackendConfig[]> = globalSingleton(
  'ghuri.tasks.backendOverrides',
  () => new Map(),
)

function isConfig(value: unknown): value is TaskBackendConfig {
  return typeof value === 'object' && value !== null && typeof (value as any).create === 'function'
}

/** The `TASKS` setting of the current context (undefined when not set). */
export function tasksSetting(): Record<string, unknown> | undefined {
  return tryGetContext()?.settings?.TASKS as Record<string, unknown> | undefined
}

/** The task backends (Django's `task_backends`). */
export const taskBackends = {
  /** The `TASKS` entry for `alias` (with test overrides applied), or undefined. */
  config(alias: string = DEFAULT_TASK_BACKEND_ALIAS): TaskBackendConfig | undefined {
    const stack = overrides.get(alias)
    if (stack?.length) return stack[stack.length - 1]
    const setting = tasksSetting()
    if (!setting) return alias === DEFAULT_TASK_BACKEND_ALIAS ? DEFAULT_CONFIG : undefined
    const entry = setting[alias]
    if (entry === undefined) return undefined
    if (!isConfig(entry)) {
      throw new InvalidTaskBackend(
        `TASKS['${alias}'] is not a task backend: use immediate(), dummy(), database() or cloudflareQueues().`,
      )
    }
    return entry
  },

  /** The backend for `alias`. Raises `InvalidTaskBackend` when it is not configured. */
  get(alias: string = DEFAULT_TASK_BACKEND_ALIAS): BaseTaskBackend {
    const config = this.config(alias)
    if (!config)
      throw new InvalidTaskBackend(`The task backend '${alias}' is not configured (settings.TASKS).`)
    return config.create(alias)
  },

  /** Configured aliases. */
  aliases(): string[] {
    const setting = tasksSetting()
    const names = new Set(setting ? Object.keys(setting) : [DEFAULT_TASK_BACKEND_ALIAS])
    for (const [alias, stack] of overrides) if (stack.length) names.add(alias)
    return [...names]
  },

  /** Every configured backend. */
  all(): BaseTaskBackend[] {
    return this.aliases().map((a) => this.get(a))
  },

  /** Use `config` for `alias` until the returned function is called (tests; see `useTaskBackend`). */
  override(alias: string, config: TaskBackendConfig): () => void {
    const stack = overrides.get(alias) ?? []
    stack.push(config)
    overrides.set(alias, stack)
    return () => {
      const i = stack.lastIndexOf(config)
      if (i >= 0) stack.splice(i, 1)
    }
  },
}

/** The `'default'` backend of the current context (Django's `default_task_backend`). */
export const defaultTaskBackend: BaseTaskBackend = new Proxy({} as BaseTaskBackend, {
  get(_target, prop) {
    const backend = taskBackends.get()
    const value = (backend as any)[prop]
    return typeof value === 'function' ? value.bind(backend) : value
  },
  has(_target, prop) {
    return prop in taskBackends.get()
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(taskBackends.get())
  },
})
