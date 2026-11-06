// Match Claude Telegram's bot-file captions and text cuts. A caption is kept as Telegram keeps one, read live
// on 2026-11-06: every carriage return and U+2028 to U+202E removed, every other control character but the line
// break turned into a space, then spaces and line breaks trimmed at each edge; anything else stays. Telegram counts
// what is left in characters (code points) against 1024 and keeps an empty result as no caption. A caption edit
// reads the same rule. A longer text goes as text messages, with only spaces and line breaks trimmed at its edges.
export const CAPTION_MAX = 1024
const textTrim = text => text.replace(/^[ \n]+|[ \n]+$/g, '')
export const captionText = text => textTrim(text.replace(/[\r\u2028-\u202e]/g, '').replace(/[\0-\t\v-\x1f]/g, ' '))
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
