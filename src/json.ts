export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Why `value` would not survive `JSON.stringify` / `JSON.parse` unchanged, or null when it would. Django's rule for
 * task arguments and return values: `Date`, `Map`, class instances (model instances), `undefined`, `NaN` and
 * functions are refused instead of being silently converted.
 */
export function jsonProblem(value: unknown, path = 'value', seen: Set<object> = new Set()): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} is ${value}`
  if (value === undefined) return `${path} is undefined`
  if (typeof value !== 'object') return `${path} is a ${typeof value}`
  if (seen.has(value)) return `${path} is a circular reference`
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const p = jsonProblem(value[i], `${path}[${i}]`, seen)
        if (p) return p
      }
      return null
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      return `${path} is a ${(value as object).constructor?.name ?? 'non-plain object'} (pass JSON: a primary key, an ISO string…)`
    }
    for (const [k, v] of Object.entries(value)) {
      const p = jsonProblem(v, `${path}.${k}`, seen)
      if (p) return p
    }
    return null
  } finally {
    seen.delete(value)
  }
}
