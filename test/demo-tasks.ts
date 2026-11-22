import { task } from '../src/index'
import { localeStorage } from './demo'

/** Calls made by tasks, for assertions. */
export const calls: string[] = []
/** How many times `flaky` still fails. */
export const flakyState = { failuresLeft: 0 }

export const add = task(async (a: number, b: number) => {
  calls.push(`add ${a} ${b}`)
  return a + b
})

export const boom = task(async () => {
  calls.push('boom')
  throw new TypeError('kaboom')
})

export const flaky = task(
  async (label: string) => {
    calls.push(`flaky ${label}`)
    if (flakyState.failuresLeft > 0) {
      flakyState.failuresLeft--
      throw new Error('not yet')
    }
    return `ok ${label}`
  },
  { maxAttempts: 3, retryDelay: 30 },
)

export const attemptNumber = task(async (ctx) => ctx.attempt, { takesContext: true })

export const badReturn = task(async () => new Date())

export const whichLocale = task(async () => localeStorage.getStore() ?? null)

export const emails = task(async (to: string) => `sent to ${to}`, { queueName: 'emails' })

export const nothing = task(() => {})
