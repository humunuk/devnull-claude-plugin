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
