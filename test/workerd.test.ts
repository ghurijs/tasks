// The tasks bundle on workerd: it must start (workerd forbids random values at module scope), run a task through a
// real Cloudflare Queue and the app's queue() handler, and run immediate() tasks inside a request.
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('tasks on workerd', () => {
  let mf: Miniflare
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser', 'import'],
      external: ['node:*', 'cloudflare:*', 'postgres'],
      write: false,
      logLevel: 'silent',
    })
    // Modules listed explicitly (as wrangler does): the bundle keeps the computed `import()` of node:fs that
    // `ghuri check` uses on Node, which Miniflare's dependency scan of a plain `script` refuses.
    const options = {
      modules: [{ type: 'ESModule', path: 'worker.js', contents: out.outputFiles[0].text }],
      compatibilityDate: '2025-06-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: `tasks-${crypto.randomUUID()}` },
      queueProducers: { TASKS_QUEUE: 'tasks' },
      queueConsumers: { tasks: { maxBatchTimeout: 0 } },
    }
    const mod: any = await import('miniflare')
    mf = new Miniflare(
      typeof mod.convertV4MiniflareOptions === 'function'
        ? mod.convertV4MiniflareOptions(options)
        : (options as any),
    )
  }, 60_000)
  afterAll(async () => {
    await mf?.dispose()
  })

  it('starts, and runs a task through Cloudflare Queues', async () => {
    expect((await mf.dispatchFetch('https://example.com/__setup/')).status).toBe(200)
    const enqueued = (await (await mf.dispatchFetch('https://example.com/__enqueue/')).json()) as any
    expect(enqueued.status).toBe('READY')
    let result: any
    for (let i = 0; i < 50; i++) {
      result = await (await mf.dispatchFetch(`https://example.com/__result/?id=${enqueued.id}`)).json()
      if (result.status === 'SUCCESSFUL' || result.status === 'FAILED') break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect([result.status, result.value]).toEqual(['SUCCESSFUL', 5])
    expect(result.workerIds).toHaveLength(1)
    expect(result.workerIds[0]).toMatch(/^[0-9a-f]{12}$/)
  }, 30_000)

  it('runs immediate() tasks inside the request, with the same isolate worker id', async () => {
    const one = (await (await mf.dispatchFetch('https://example.com/__immediate/')).json()) as any
    const two = (await (await mf.dispatchFetch('https://example.com/__immediate/')).json()) as any
    expect([one.status, one.value]).toEqual(['SUCCESSFUL', 42])
    expect(two.workerIds).toEqual(one.workerIds)
  })
})
