// A test app with tasks, and a context carrier (`locale`) to check that tasks keep request context.

import { AsyncLocalStorage } from 'node:async_hooks'
import { AppConfig, registerContextCarrier } from '@ghuri/core'
import * as demoTasks from './demo-tasks'

export const localeStorage = new AsyncLocalStorage<string>()

registerContextCarrier({
  name: 'locale',
  capture: () => localeStorage.getStore(),
  restore: (value, fn) => localeStorage.run(value, fn),
})

export class DemoConfig extends AppConfig {
  name = 'demo'
  // No `override`: AppConfig declares `tasks` only from @ghuri/core 0.1.0-alpha.5.
  tasks = demoTasks
}
