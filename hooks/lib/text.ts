// Cleaning text the mod did not write before anyone sees it (security rule 3).
// A terminal acts on escape sequences and bidi controls, so text from outside
// could repaint the screen, forge a line, or show one thing and mean another.

// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \, or never ended), the
// other string sequences DCS, SOS, PM, APC (ESC P, X, ^, _ ... ESC \), and any
// other two-byte ESC sequence.
const ESCAPE_SEQUENCES =
  /\u001b\[[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -~]?/g

// C0 controls but newline, DEL, the C1 controls, and the bidi embeddings,
// overrides and isolates U+202A to U+202E and U+2066 to U+2069.
const CONTROLS_KEEPING_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

const ELLIPSIS = '\u2026'

/**
 * Cleans text for drawing on one line: escape sequences and controls are
 * removed, line breaks (U+2028 and U+2029 too) and tabs become spaces, and the result is held to
 * `max` characters (code points), ending in an ellipsis when it was cut.
 */
export function cleanLine(text: string, max: number): string {
  const flat = text
    .replace(ESCAPE_SEQUENCES, '')
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(CONTROLS_KEEPING_NEWLINE, '')
    .trim()

  return cap(flat, max)
}

function cap(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text

  return points.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS
}

export type CleanBody = {
  lines: string[]
  /** Whether text was left out; the last line then ends in an ellipsis. */
  isCut: boolean
}

/**
 * Cleans text for drawing on at most `maxLines` lines, cleaned as cleanLine
 * cleans but keeping line breaks: `\r\n`, `\r`, U+2028 and U+2029 become
 * `\n`, tabs become spaces, trailing spaces and blank lines at either end are
 * dropped. The lines hold at most `maxCodePoints` code points in all, the
 * ellipsis included.
 */
export function cleanBody(text: string, { maxLines, maxCodePoints }: { maxLines: number; maxCodePoints: number }): CleanBody {
  const all = text
    .replace(ESCAPE_SEQUENCES, '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROLS_KEEPING_NEWLINE, '')
    .split('\n')
    .map(line => line.trimEnd())
  let start = 0
  while (start < all.length && all[start] === '') start += 1
  let end = all.length
  while (end > start && all[end - 1] === '') end -= 1
  const lines = all.slice(start, end)
  if (maxLines < 1) return { lines: [], isCut: lines.length > 0 }

  const kept: string[] = []
  let spare = maxCodePoints
  for (const line of lines) {
    // Blank lines at the end were dropped, so a line left over means text is cut.
    if (kept.length === maxLines || spare <= 0) return { lines: endWithEllipsis(kept, spare), isCut: true }
    const points = Array.from(line)
    if (points.length > spare) {
      kept.push(points.slice(0, Math.max(0, spare - 1)).join('') + ELLIPSIS)

      return { lines: kept, isCut: true }
    }
    kept.push(line)
    spare -= points.length
  }

  return { lines: kept, isCut: false }
}

/** The lines with an ellipsis on the last one, which gives up a code point when none is spare. */
function endWithEllipsis(lines: readonly string[], spare: number): string[] {
  const last = lines[lines.length - 1]
  if (last === undefined) return [ELLIPSIS]
  const points = Array.from(last)

  return [...lines.slice(0, -1), (spare > 0 ? points : points.slice(0, -1)).join('') + ELLIPSIS]
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

/** From this many weeks on, an age is shown as the date. */
export const DATE_AFTER_WEEKS = 8

/**
 * How long ago `createdAtMs` was, short: `now` under a minute (and for a time
 * ahead of the clock), then `5m`, `3h`, `2d`, `5w`, and from 8 weeks the UTC
 * date as `YYYY-MM-DD`. `''` for a time no date can hold.
 */
export function relativeAge(createdAtMs: number, nowMs: number): string {
  const date = new Date(createdAtMs)
  if (Number.isNaN(date.getTime()) || !Number.isFinite(nowMs)) return ''
  const age = nowMs - createdAtMs
  if (age < MINUTE_MS) return 'now'
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m`
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`
  if (age < WEEK_MS) return `${Math.floor(age / DAY_MS)}d`
  if (age < DATE_AFTER_WEEKS * WEEK_MS) return `${Math.floor(age / WEEK_MS)}w`

  return date.toISOString().slice(0, 10)
}
