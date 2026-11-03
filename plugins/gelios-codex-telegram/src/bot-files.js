// Match Claude Telegram's bot-file captions and text cuts. Telegram trims
// spaces and line breaks at each edge; tabs and other whitespace are retained.
export function botFileText(text) {
  const kept = text.replace(/^[ \n]+|[ \n]+$/g, '')
  if (!kept) return { pieces: [] }
  if (kept.length <= 1024) return { caption: kept, pieces: [] }
  return { pieces: botTextPieces(kept) }
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
