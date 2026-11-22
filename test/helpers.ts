import { createApp, defineSettings, type Env, type GhuriSettings } from '@ghuri/core'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { TasksConfig } from '../src/index'
import { DemoConfig } from './demo'
import { calls, flakyState } from './demo-tasks'

export const backends: TestBackend[] = (process.env.GHURI_TEST_BACKENDS?.split(',') as
  | TestBackend[]
  | undefined) ?? ['sqlite', 'pglite']

export interface HarnessOptions {
  using?: TestBackend
  settings?: Partial<GhuriSettings> & Record<string, unknown>
  env?: Env
  /** Install the tasks app and a test database (default true). */
  database?: boolean
}

export async function setupHarness(opts: HarnessOptions = {}) {
  const env: Env = opts.env ?? {}
  const withDb = opts.database !== false
  const settings = defineSettings(() => ({
    SECRET_KEY: 'test-secret',
    DEBUG: true,
    INSTALLED_APPS: withDb ? [TasksConfig, DemoConfig] : [DemoConfig],
    ROOT_URLCONF: [],
    ...opts.settings,
  }))
  const app = createApp(settings, { checks: false })
  const ctx = await app.setup(env)
  const db: TestDatabase | null = withDb ? await setupTestDatabase({ using: opts.using ?? 'sqlite' }) : null
  return { app, env, ctx, db }
}

export type Harness = Awaited<ReturnType<typeof setupHarness>>

/** Per-describe harness; the database is flushed and the demo state reset before each test. */
export function useHarness(factory: () => HarnessOptions = () => ({})): Harness {
  const h = {} as Harness
  beforeAll(async () => {
    Object.assign(h, await setupHarness(factory()))
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    await h.db?.flush()
    calls.length = 0
    flakyState.failuresLeft = 0
  })
  return h
}
