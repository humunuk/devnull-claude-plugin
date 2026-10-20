import { describe, expect, test } from 'claude-code/testing'

import { DATE_AFTER_WEEKS, cleanBody, relativeAge } from '../hooks/lib/text'

const ELLIPSIS = '\u2026'

describe('a body cleaned for drawing', () => {
  const wide = { maxLines: 20, maxCodePoints: 1000 }

  test('keeps its lines, whatever ends them', () => {
    expect(cleanBody('one\r\ntwo\rthree\nfour\u2028five\u2029six', wide)).toEqual({
      lines: ['one', 'two', 'three', 'four', 'five', 'six'],
      isCut: false,
    })
  })

  test('keeps blank lines and indentation inside, and drops them at the ends', () => {
    expect(cleanBody('\n\n  \nfirst  \n\n  indented\t\n \n\n', wide)).toEqual({
      lines: ['first', '', '  indented'],
      isCut: false,
    })
    expect(cleanBody(' \n\t\n', wide)).toEqual({ lines: [], isCut: false })
    expect(cleanBody('', wide)).toEqual({ lines: [], isCut: false })
  })

  test('loses escape sequences, controls and bidi characters, and turns tabs into spaces', () => {
    const hostile = [
      '\u001b[31mred\u001b[0m',
      '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007',
      '\u001b]0;title\u001b\\done',
      '\u202egnp.exe\u202c and \u2066iso\u2069',
      '\u009b31m\u0085next',
      'a\tb\u0000c\u0007d\u007fe\u000bf\u000cg',
    ].join('\n')

    const { lines, isCut } = cleanBody(hostile, wide)

    expect(lines).toEqual(['red', 'link', 'done', 'gnp.exe and iso', '31mnext', 'a bcdefg'])
    expect(isCut).toBe(false)
    expect(lines.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
    expect(lines.join('\n')).not.toContain('evil.example')
  })

  test('is cut after the last line allowed, with an ellipsis', () => {
    expect(cleanBody('one\ntwo\nthree', { maxLines: 2, maxCodePoints: 100 })).toEqual({
      lines: ['one', `two${ELLIPSIS}`],
      isCut: true,
    })
    expect(cleanBody('one\ntwo\n\n\n', { maxLines: 2, maxCodePoints: 100 })).toEqual({
      lines: ['one', 'two'],
      isCut: false,
    })
    expect(cleanBody('one\n\nthree', { maxLines: 2, maxCodePoints: 100 })).toEqual({
      lines: ['one', ELLIPSIS],
      isCut: true,
    })
  })

  test('is cut at the code point limit, counting an emoji as one', () => {
    const party = '\u{1f389}'
    expect(cleanBody(party.repeat(10), { maxLines: 5, maxCodePoints: 10 })).toEqual({
      lines: [party.repeat(10)],
      isCut: false,
    })
    expect(cleanBody(party.repeat(11), { maxLines: 5, maxCodePoints: 10 })).toEqual({
      lines: [`${party.repeat(9)}${ELLIPSIS}`],
      isCut: true,
    })
    expect(cleanBody(`abc\n${party.repeat(10)}`, { maxLines: 5, maxCodePoints: 10 })).toEqual({
      lines: ['abc', `${party.repeat(6)}${ELLIPSIS}`],
      isCut: true,
    })
  })

  test('gives up a code point for the ellipsis when the lines used all of them', () => {
    expect(cleanBody('abcde\nmore', { maxLines: 5, maxCodePoints: 5 })).toEqual({
      lines: [`abcd${ELLIPSIS}`],
      isCut: true,
    })
  })

  test('draws nothing when no line is allowed', () => {
    expect(cleanBody('text', { maxLines: 0, maxCodePoints: 10 })).toEqual({ lines: [], isCut: true })
    expect(cleanBody('', { maxLines: 0, maxCodePoints: 10 })).toEqual({ lines: [], isCut: false })
  })
})

describe('the age of a commit', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0)
  const ago = (ms: number) => relativeAge(now - ms, now)
  const second = 1000
  const minute = 60 * second
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day

  test('is now under a minute, and for a time ahead of the clock', () => {
    expect(ago(0)).toBe('now')
    expect(ago(59 * second)).toBe('now')
    expect(ago(-5 * minute)).toBe('now')
  })

  test('counts minutes, hours, days and weeks, rounded down', () => {
    expect(ago(minute)).toBe('1m')
    expect(ago(5 * minute + 59 * second)).toBe('5m')
    expect(ago(59 * minute)).toBe('59m')
    expect(ago(hour)).toBe('1h')
    expect(ago(3 * hour)).toBe('3h')
    expect(ago(23 * hour + 59 * minute)).toBe('23h')
    expect(ago(day)).toBe('1d')
    expect(ago(2 * day)).toBe('2d')
    expect(ago(6 * day + 23 * hour)).toBe('6d')
    expect(ago(week)).toBe('1w')
    expect(ago(5 * week)).toBe('5w')
    expect(ago(DATE_AFTER_WEEKS * week - 1)).toBe(`${DATE_AFTER_WEEKS - 1}w`)
  })

  test('is the UTC date from 8 weeks on', () => {
    expect(DATE_AFTER_WEEKS).toBe(8)
    expect(relativeAge(now - DATE_AFTER_WEEKS * week, now)).toBe('2026-08-25')
    expect(relativeAge(Date.UTC(2026, 7, 20, 23, 30), now)).toBe('2026-08-20')
    expect(relativeAge(Date.UTC(2020, 0, 2, 0, 0), now)).toBe('2020-01-02')
  })

  test('is empty for a time no date can hold', () => {
    expect(relativeAge(Number.NaN, now)).toBe('')
    expect(relativeAge(9e15, now)).toBe('')
    expect(relativeAge(now, Number.NaN)).toBe('')
  })
})
