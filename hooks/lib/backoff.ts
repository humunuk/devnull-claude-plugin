// How long to wait before the next poll of dev-null.sh (security rule 8).
// Pure: the caller keeps one request in flight and runs the timer. A request
// can itself take 30 s to fail ($.http.fetch gives up after 30000 ms), which
// comes on top of the delay computed here.

export const POLL_MIN_SECONDS = 30

export const BACKOFF_MAX_SECONDS = 15 * 60

/**
 * `Retry-After` in seconds, only when it is a plain whole number of at most six
 * digits. An HTTP date, a fraction, a sign or spaces are ignored, as is a
 * missing header.
 */
export function retryAfterSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,6}$/.test(value)) return undefined

  return Number(value)
}

/**
 * The wait before the next poll, in milliseconds. The interval is at least
 * 30 s; each failure in a row doubles it, up to 15 minutes (or the interval,
 * when that is longer). A `Retry-After` of plain seconds wins when it is longer.
 */
export function pollDelayMs({
  intervalSeconds,
  consecutiveFailures,
  retryAfter,
}: {
  intervalSeconds: number
  consecutiveFailures: number
  /** The raw `Retry-After` header of the last answer, if it had one. */
  retryAfter: string | undefined
}): number {
  const interval = Number.isFinite(intervalSeconds) ? Math.max(POLL_MIN_SECONDS, intervalSeconds) : POLL_MIN_SECONDS
  const failures = Number.isSafeInteger(consecutiveFailures) && consecutiveFailures > 0 ? consecutiveFailures : 0
  const ceiling = Math.max(BACKOFF_MAX_SECONDS, interval)
  // 2 ** failures grows past any ceiling quickly; Infinity is capped as well.
  const backedOff = Math.min(interval * 2 ** failures, ceiling)
  const asked = retryAfterSeconds(retryAfter) ?? 0

  return Math.max(backedOff, asked) * 1000
}
