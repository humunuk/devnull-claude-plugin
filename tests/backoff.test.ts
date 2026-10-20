import { describe, expect, test } from 'claude-code/testing'

import { BACKOFF_MAX_SECONDS, POLL_MIN_SECONDS, pollDelayMs, retryAfterSeconds } from '../hooks/lib/backoff'

const delay = (intervalSeconds: number, consecutiveFailures = 0, retryAfter?: string) =>
  pollDelayMs({ intervalSeconds, consecutiveFailures, retryAfter })

describe('the poll delay', () => {
  test('is the interval while polls succeed', () => {
    expect(delay(60)).toBe(60_000)
    expect(delay(45)).toBe(45_000)
    expect(delay(3600)).toBe(3_600_000)
  })

  test('is never under 30 seconds', () => {
    expect(POLL_MIN_SECONDS).toBe(30)
    for (const interval of [0, 1, 29.9, -60, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(delay(interval)).toBe(30_000)
    }
  })

  test('doubles with each failure in a row, up to 15 minutes', () => {
    expect(BACKOFF_MAX_SECONDS).toBe(900)
    expect(delay(60, 1)).toBe(120_000)
    expect(delay(60, 2)).toBe(240_000)
    expect(delay(60, 3)).toBe(480_000)
    expect(delay(60, 4)).toBe(900_000)
    expect(delay(60, 50)).toBe(900_000)
    expect(delay(60, 5000)).toBe(900_000)
    expect(delay(10, 1)).toBe(60_000)
  })

  test('never backs off to less than the interval itself', () => {
    expect(delay(3600, 3)).toBe(3_600_000)
  })

  test('counts a failure count that is not a whole positive number as none', () => {
    for (const failures of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(delay(60, failures)).toBe(60_000)
    }
  })

  test('waits as long as Retry-After asks when that is longer', () => {
    expect(delay(60, 0, '120')).toBe(120_000)
    expect(delay(60, 0, '10')).toBe(60_000)
    expect(delay(60, 0, '0')).toBe(60_000)
    expect(delay(60, 2, '200')).toBe(240_000)
    expect(delay(60, 4, '3600')).toBe(3_600_000)
  })

  test('ignores a Retry-After that is not plain whole seconds', () => {
    for (const value of ['1.5', '-3', '+120', ' 120', '120 ', '120s', '', 'Wed, 21 Oct 2026 07:28:00 GMT', '9999999', '\u0661\u0662\u0660']) {
      expect(delay(60, 0, value)).toBe(60_000)
      expect(retryAfterSeconds(value)).toBeUndefined()
    }
    expect(retryAfterSeconds(undefined)).toBeUndefined()
    expect(retryAfterSeconds('999999')).toBe(999_999)
  })
})
