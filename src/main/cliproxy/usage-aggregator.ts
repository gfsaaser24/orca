import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CpaUsageAggregate } from '../../shared/cliproxy-types'
import type { ManagementClient } from './management-client'

const WINDOW_MS = 5 * 60 * 1_000
const RETENTION_MS = 24 * 60 * 60 * 1_000
const RESERVOIR_CAPACITY = 256
const QUEUE_BATCH_SIZE = 200
const POLL_MS = 2_000

type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx'

type SafeUsageSample = {
  provider: string
  model: string | null
  alias: string | null
  authIndex: string | null
  ts: number
  latency: number | null
  ttft: number | null
  statusClass: StatusClass
  tokensIn: number
  tokensOut: number
}

type UsageWindow = {
  key: string
  requests: number
  failures: number
  tokensIn: number
  tokensOut: number
  windowStart: number
  windowEnd: number
  latencyCount: number
  latencies: number[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function nonnegativeInteger(value: unknown): number {
  const number = finiteNumber(value)
  return number === null || number < 0 ? 0 : Math.floor(number)
}
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
function timestamp(value: unknown): number | null {
  const number = finiteNumber(value)
  if (number !== null) {
    return number
  }
  if (typeof value !== 'string') {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function statusClass(status: number | null, failed: boolean): StatusClass {
  if (status !== null && status >= 100 && status < 600) {
    return `${Math.floor(status / 100)}xx` as StatusClass
  }
  return failed ? '5xx' : '2xx'
}

function whitelistUsageRecord(raw: unknown): SafeUsageSample | null {
  try {
    const item = record(raw)
    if (!item) {
      return null
    }
    const tokens = record(item.tokens)
    const fail = record(item.fail)
    const failed = item.failed === true
    const status =
      finiteNumber(item.status) ?? finiteNumber(item.status_code) ?? finiteNumber(fail?.status_code)
    return {
      provider: optionalString(item.provider) ?? 'unknown',
      model: optionalString(item.model),
      alias: optionalString(item.alias),
      authIndex: optionalString(item.auth_index),
      ts: timestamp(item.ts) ?? timestamp(item.timestamp) ?? Date.now(),
      latency: finiteNumber(item.latency) ?? finiteNumber(item.latency_ms),
      ttft: finiteNumber(item.ttft) ?? finiteNumber(item.ttft_ms),
      statusClass: statusClass(status, failed),
      tokensIn: nonnegativeInteger(tokens?.input_tokens ?? item.input_tokens),
      tokensOut: nonnegativeInteger(tokens?.output_tokens ?? item.output_tokens)
    }
  } catch {
    // Why: even hostile accessors on a raw queue item must not escape with secret-bearing details.
    return null
  }
}

function percentile50(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.5) - 1]
}

function windowMapKey(key: string, windowStart: number): string {
  return `${windowStart}\u0000${key}`
}
function validWindow(value: unknown): UsageWindow | null {
  const item = record(value)
  if (!item) {
    return null
  }
  const key = optionalString(item.key)
  const windowStart = finiteNumber(item.windowStart)
  const windowEnd = finiteNumber(item.windowEnd)
  if (!key || windowStart === null || windowEnd === null || windowEnd <= windowStart) {
    return null
  }
  const rawLatencies = Array.isArray(item.latencies) ? item.latencies : []
  const latencies = rawLatencies
    .map(finiteNumber)
    .filter((latency): latency is number => latency !== null && latency >= 0)
    .slice(0, RESERVOIR_CAPACITY)
  return {
    key,
    requests: nonnegativeInteger(item.requests),
    failures: nonnegativeInteger(item.failures),
    tokensIn: nonnegativeInteger(item.tokensIn),
    tokensOut: nonnegativeInteger(item.tokensOut),
    windowStart,
    windowEnd,
    latencyCount: Math.max(nonnegativeInteger(item.latencyCount), latencies.length),
    latencies
  }
}

export function createUsageAggregator(
  client: ManagementClient,
  persistPath: string
): {
  start(): Promise<void>
  stop(): void
  snapshot(): CpaUsageAggregate[]
} {
  const windows = new Map<string, UsageWindow>()
  let running = false
  let pollTimer: NodeJS.Timeout | null = null
  let pollPromise: Promise<void> | null = null
  let startPromise: Promise<void> | null = null
  let persistSequence = 0
  const prune = (now = Date.now()): void => {
    const cutoff = now - RETENTION_MS
    for (const [key, aggregate] of windows) {
      if (aggregate.windowEnd <= cutoff) {
        windows.delete(key)
      }
    }
  }
  const addLatency = (aggregate: UsageWindow, latency: number | null): void => {
    if (latency === null || latency < 0) {
      return
    }
    aggregate.latencyCount += 1
    if (aggregate.latencies.length < RESERVOIR_CAPACITY) {
      aggregate.latencies.push(latency)
      return
    }
    const replacement = Math.floor(Math.random() * aggregate.latencyCount)
    if (replacement < RESERVOIR_CAPACITY) {
      aggregate.latencies[replacement] = latency
    }
  }
  const addToKey = (sample: SafeUsageSample, key: string): void => {
    const windowStart = Math.floor(sample.ts / WINDOW_MS) * WINDOW_MS
    const mapKey = windowMapKey(key, windowStart)
    let aggregate = windows.get(mapKey)
    if (!aggregate) {
      aggregate = {
        key,
        requests: 0,
        failures: 0,
        tokensIn: 0,
        tokensOut: 0,
        windowStart,
        windowEnd: windowStart + WINDOW_MS,
        latencyCount: 0,
        latencies: []
      }
      windows.set(mapKey, aggregate)
    }
    aggregate.requests += 1
    if (sample.statusClass === '4xx' || sample.statusClass === '5xx') {
      aggregate.failures += 1
    }
    aggregate.tokensIn += sample.tokensIn
    aggregate.tokensOut += sample.tokensOut
    addLatency(aggregate, sample.latency)
  }
  const ingest = (raw: unknown): void => {
    // Why: this is the destructive-pop trust boundary; only this fixed projection survives it (D9).
    const sample = whitelistUsageRecord(raw)
    if (!sample) {
      return
    }
    addToKey(sample, `provider:${sample.provider}`)
    if (sample.authIndex) {
      addToKey(sample, `account:${sample.provider}:${sample.authIndex}`)
    }
  }
  const persistedWindows = (): UsageWindow[] =>
    [...windows.values()]
      .sort(
        (left, right) => left.windowStart - right.windowStart || left.key.localeCompare(right.key)
      )
      .map((aggregate) => ({
        key: aggregate.key,
        requests: aggregate.requests,
        failures: aggregate.failures,
        tokensIn: aggregate.tokensIn,
        tokensOut: aggregate.tokensOut,
        windowStart: aggregate.windowStart,
        windowEnd: aggregate.windowEnd,
        latencyCount: aggregate.latencyCount,
        latencies: [...aggregate.latencies]
      }))
  const persist = async (): Promise<void> => {
    const payload = { version: 1, windows: persistedWindows() }
    const temporaryPath = `${persistPath}.tmp-${process.pid}-${persistSequence++}`
    try {
      await mkdir(dirname(persistPath), { recursive: true })
      await writeFile(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, persistPath)
    } catch {
      try {
        await unlink(temporaryPath)
      } catch {
        /* A missing temp file is expected when mkdir/write did not succeed. */
      }
    }
  }
  const load = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(await readFile(persistPath, 'utf8')) as unknown
      const envelope = record(parsed)
      if (envelope?.version !== 1 || !Array.isArray(envelope.windows)) {
        return
      }
      for (const rawWindow of envelope.windows) {
        const aggregate = validWindow(rawWindow)
        if (aggregate) {
          windows.set(windowMapKey(aggregate.key, aggregate.windowStart), aggregate)
        }
      }
    } catch {}
  }
  const poll = (): Promise<void> => {
    if (pollPromise) {
      return pollPromise
    }
    pollPromise = (async () => {
      try {
        const items = await client.usageQueuePop(QUEUE_BATCH_SIZE)
        for (const item of items) {
          ingest(item)
        }
      } catch {}
      prune()
      // Crash between the destructive pop above and this aggregate-only write may lose this batch.
      await persist()
    })().finally(() => {
      pollPromise = null
    })
    return pollPromise
  }
  const start = (): Promise<void> => {
    if (startPromise) {
      return startPromise
    }
    running = true
    startPromise = (async () => {
      await load()
      prune()
      await poll()
      if (!running) {
        return
      }
      pollTimer = setInterval(() => void poll(), POLL_MS)
      pollTimer.unref?.()
    })()
    return startPromise
  }
  const stop = (): void => {
    running = false
    startPromise = null
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
  const snapshot = (): CpaUsageAggregate[] => {
    prune()
    return [...windows.values()]
      .sort(
        (left, right) => left.windowStart - right.windowStart || left.key.localeCompare(right.key)
      )
      .map((aggregate) => ({
        key: aggregate.key,
        requests: aggregate.requests,
        failures: aggregate.failures,
        tokensIn: aggregate.tokensIn,
        tokensOut: aggregate.tokensOut,
        p50LatencyMs: percentile50(aggregate.latencies),
        windowStart: aggregate.windowStart,
        windowEnd: aggregate.windowEnd
      }))
  }
  return { start, stop, snapshot }
}
