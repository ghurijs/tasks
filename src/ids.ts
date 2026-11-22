const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

let lastMs = Number.NEGATIVE_INFINITY
let counter = 0

/**
 * A UUID version 7 (RFC 9562): 48-bit Unix milliseconds, a 12-bit counter, then random bits. Ids from one
 * process are strictly increasing (the counter orders ids made in the same millisecond, RFC 9562 §6.2 method 1),
 * so tasks enqueued together run in enqueue order.
 */
export function newTaskId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  const now = Date.now()
  if (now > lastMs) {
    lastMs = now
    counter = b[7] & 0x3ff // seed below 1024, leaving room to count up
  } else if (counter < 0xfff) {
    counter++
  } else {
    lastMs++
    counter = 0
  }
  const ms = lastMs
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = Math.floor(ms / 2 ** 24) & 0xff
  b[3] = Math.floor(ms / 2 ** 16) & 0xff
  b[4] = Math.floor(ms / 2 ** 8) & 0xff
  b[5] = ms & 0xff
  b[6] = 0x70 | (counter >>> 8)
  b[7] = counter & 0xff
  b[8] = 0x80 | (b[8] & 0x3f)
  let h = ''
  for (const x of b) h += HEX[x]
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A short id for this worker (isolate / process), recorded in `TaskResult.workerIds`. */
export function newWorkerId(): string {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  let h = ''
  for (const x of b) h += HEX[x]
  return h
}
