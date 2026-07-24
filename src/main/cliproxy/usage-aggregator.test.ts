import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageAggregator } from './usage-aggregator'

const temporaryDirectories: string[] = []

async function persistPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-cpa-usage-'))
  temporaryDirectories.push(directory)
  return join(directory, 'usage.json')
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('createUsageAggregator', () => {
  it('whitelists queue records before aggregation or persistence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const path = await persistPath()
    const record = {
      provider: 'codex',
      model: 'gpt-5.4',
      alias: 'work',
      auth_index: '7',
      timestamp: '2026-07-24T12:00:01.000Z',
      latency_ms: 90,
      ttft_ms: 20,
      failed: true,
      fail: {
        status_code: 503,
        body: 'POISON_FAILURE_BODY'
      },
      tokens: {
        input_tokens: 11,
        output_tokens: 13
      },
      api_key: 'POISON_CLIENT_KEY',
      response_headers: {
        authorization: 'POISON_HEADER'
      }
    }
    const client = {
      usageQueuePop: vi.fn().mockResolvedValueOnce([record]).mockResolvedValue([])
    }
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ]
    const aggregator = createUsageAggregator(client as never, path)

    await aggregator.start()
    aggregator.stop()

    expect(aggregator.snapshot()).toEqual([
      {
        key: 'account:codex:7',
        requests: 1,
        failures: 1,
        tokensIn: 11,
        tokensOut: 13,
        p50LatencyMs: 90,
        windowStart: Date.parse('2026-07-24T12:00:00.000Z'),
        windowEnd: Date.parse('2026-07-24T12:05:00.000Z')
      },
      {
        key: 'provider:codex',
        requests: 1,
        failures: 1,
        tokensIn: 11,
        tokensOut: 13,
        p50LatencyMs: 90,
        windowStart: Date.parse('2026-07-24T12:00:00.000Z'),
        windowEnd: Date.parse('2026-07-24T12:05:00.000Z')
      }
    ])
    const persisted = await readFile(path, 'utf8')
    expect(persisted).not.toContain('POISON_FAILURE_BODY')
    expect(persisted).not.toContain('POISON_CLIENT_KEY')
    expect(persisted).not.toContain('POISON_HEADER')
    expect(JSON.stringify(aggregator.snapshot())).not.toContain('POISON')
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('computes an honest p50 from the latency reservoir', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const path = await persistPath()
    const records = [50, 10, 30, 20, 40].map((latency) => ({
      provider: 'xai',
      timestamp: '2026-07-24T12:00:02.000Z',
      latency_ms: latency,
      failed: false,
      fail: { status_code: 200 },
      tokens: { input_tokens: 1, output_tokens: 2 }
    }))
    const client = {
      usageQueuePop: vi.fn().mockResolvedValueOnce(records).mockResolvedValue([])
    }
    const aggregator = createUsageAggregator(client as never, path)

    await aggregator.start()
    aggregator.stop()

    expect(aggregator.snapshot()).toEqual([
      expect.objectContaining({
        key: 'provider:xai',
        requests: 5,
        failures: 0,
        tokensIn: 5,
        tokensOut: 10,
        p50LatencyMs: 30
      })
    ])
  })

  it('bounds the persisted latency reservoir at 256 samples', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const path = await persistPath()
    const records = Array.from({ length: 300 }, (_, latency) => ({
      provider: 'kimi',
      timestamp: '2026-07-24T12:00:03.000Z',
      latency_ms: latency,
      failed: false,
      tokens: { input_tokens: 0, output_tokens: 0 }
    }))
    const client = {
      usageQueuePop: vi.fn().mockResolvedValueOnce(records).mockResolvedValue([])
    }
    const aggregator = createUsageAggregator(client as never, path)

    await aggregator.start()
    aggregator.stop()

    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      windows: { latencies: number[]; latencyCount: number }[]
    }
    expect(persisted.windows[0].latencies).toHaveLength(256)
    expect(persisted.windows[0].latencyCount).toBe(300)
  })

  it('loads valid aggregates and prunes windows older than 24 hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const path = await persistPath()
    const currentStart = Date.parse('2026-07-24T11:55:00.000Z')
    const oldStart = Date.parse('2026-07-23T11:50:00.000Z')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        windows: [
          {
            key: 'provider:current',
            requests: 2,
            failures: 0,
            tokensIn: 3,
            tokensOut: 4,
            windowStart: currentStart,
            windowEnd: currentStart + 300_000,
            latencyCount: 2,
            latencies: [10, 20]
          },
          {
            key: 'provider:old',
            requests: 99,
            failures: 99,
            tokensIn: 99,
            tokensOut: 99,
            windowStart: oldStart,
            windowEnd: oldStart + 300_000,
            latencyCount: 1,
            latencies: [999]
          }
        ]
      })
    )
    const client = {
      usageQueuePop: vi.fn(async () => [])
    }
    const aggregator = createUsageAggregator(client as never, path)

    await aggregator.start()
    aggregator.stop()

    expect(aggregator.snapshot()).toEqual([
      {
        key: 'provider:current',
        requests: 2,
        failures: 0,
        tokensIn: 3,
        tokensOut: 4,
        p50LatencyMs: 10,
        windowStart: currentStart,
        windowEnd: currentStart + 300_000
      }
    ])
    expect(await readFile(path, 'utf8')).not.toContain('provider:old')
  })

  it('can restart polling after stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    const path = await persistPath()
    const usageRecord = {
      provider: 'codex',
      timestamp: '2026-07-24T12:00:01.000Z',
      failed: false,
      tokens: { input_tokens: 1, output_tokens: 1 }
    }
    const client = {
      usageQueuePop: vi
        .fn()
        .mockResolvedValueOnce([usageRecord])
        .mockResolvedValueOnce([usageRecord])
        .mockResolvedValue([])
    }
    const aggregator = createUsageAggregator(client as never, path)

    await aggregator.start()
    aggregator.stop()
    await aggregator.start()
    aggregator.stop()

    expect(client.usageQueuePop).toHaveBeenCalledTimes(2)
    expect(aggregator.snapshot()).toEqual([
      expect.objectContaining({ key: 'provider:codex', requests: 2 })
    ])
  })
})
