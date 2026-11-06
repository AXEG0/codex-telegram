// Match Claude Telegram's bot-file captions and text cuts. A caption is kept as Telegram keeps one. Read live on
// 2026-11-06 with a bot's sendDocument, and its editMessageCaption where the tests say so: every carriage return,
// U+2028 to U+202E and the combining marks U+030A, U+0333 and U+033F removed; every other control character below
// U+0020 but the line break turned into a space; spaces and line breaks trimmed at each edge; each character of the
// empty set below left no caption alone, and so did one mix; a send counted the rest in code points against 1024.
// By TDLib's source alone (bc9c263e), not a read: any other mix of the empty set is no caption either
// (strip_empty_characters, read back through fix_formatted_text); every other character, the C1 controls among them,
// stays (clean_input_string); the count is of code points, not grapheme clusters (utf8_length). No read or source
// shows an edit's limit or its unit, so a caption edit takes the send's rule. A longer text goes as text messages,
// with only spaces and line breaks trimmed at its edges, and one that is empty as a caption sends nothing.
export const CAPTION_MAX = 1024
const textTrim = text => text.replace(/^[ \n]+|[ \n]+$/g, '')
const kept = text => textTrim(text.replace(/[\r\u2028-\u202e\u030a\u0333\u033f]/g, '').replace(/[\0-\t\v-\x1f]/g, ' '))
export const captionText = text => { const caption = kept(text); return /^[ \n\u00a0\u1680\u180e\u2000-\u200f\u202f\u205f\u2800\u3000\ufeff\ufffc\u{e0000}-\u{e007f}]*$/u.test(caption) ? '' : caption }
export const captionLength = caption => [...caption].length
export function botFileText(text) {
  const caption = captionText(text)
  if (!caption) return { pieces: [] }
  if (captionLength(caption) <= CAPTION_MAX) return { caption, pieces: [] }
  return { pieces: botTextPieces(textTrim(text)) }
}
export function botTextPieces(text) {
  const pieces = []
  let rest = text
  while (rest.length > 4096) {
    let cut = 4096
    while (cut > 4000 && !cuttable(rest, cut)) cut -= 1
    // A run of spaces may leave no safe cut. Keep the reference's bounded
    // fallback, without cutting a UTF-16 pair in half.
    if (!cuttable(rest, cut)) cut = splitsPair(rest, 4096) ? 4095 : 4096
    pieces.push(rest.slice(0, cut)); rest = rest.slice(cut)
  }
  pieces.push(rest)
  return pieces
}
const trimmable = c => c === ' ' || c === '\n'
const splitsPair = (text, i) => {
  const high = text.charCodeAt(i - 1), low = text.charCodeAt(i)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}
const cuttable = (text, i) => !trimmable(text[i - 1]) && !trimmable(text[i]) && !splitsPair(text, i)
