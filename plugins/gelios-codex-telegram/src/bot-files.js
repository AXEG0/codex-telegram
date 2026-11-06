// Match Claude Telegram's bot-file captions and text cuts. Evidence for each part: "read" is a live read of
// api.telegram.org by a bot on 2026-11-06, a send unless it says edit; "code" is TDLib at bc9c263e, which the Bot API
// server pins.
// - Control characters below a space but the line break become spaces. Read: 0x00, 0x01, 0x0B, 0x0C and 0x1F between
//   characters, a tab between characters (also an edit), and a tab and 0x01 at each end. Code: the rest
//   (clean_input_string, misc.cpp:76-160).
// - Carriage returns, U+2028 to U+202E and the marks U+030A, U+0333 and U+033F are dropped. Read: each between
//   characters but U+202C and U+202D. Code: those two (the same function).
// - Spaces and line breaks are then trimmed from both ends. Read: spaces made from a tab or a control character, and a
//   line break at each end.
// - A result of only the empty check's characters below, alone or mixed, is no caption. Read: each alone (a no-break
//   space and U+200B on an edit only), but of the tag block's 128 only U+E0000, U+E0001, U+E0020, U+E0041 and U+E007F,
//   and one mix, a no-break space then U+200B. Code: the other 123 tags (misc.cpp:174 and :186-193) and every other mix
//   (MessageEntity.cpp:4574-4582 and :4614). Beside other text each stays. Read: a no-break space at each end, and
//   U+202F and U+200B between characters.
// - Any other character stays. Read: DEL, U+2027 and a line break between characters, U+2060 and U+E0080 alone (also
//   edits), and the C1 controls U+0085 and U+009F alone and between characters (also edits). Code: the rest.
// - What is left counts in code points against 1024. Read: 1024 'x' or U+1F600 taken, 1025 of each refused, and 'x'
//   with U+0301 512 times then 'x', 1025 code points in 513 grapheme clusters, refused. Code: an album's caption alike
//   (MessagesManager.cpp:21918).
// - A caption edit takes the send's rule and count. Read: edits that left nothing (' \t\r ' and seven characters
//   alone), the edits named above, 1024 U+1F600 taken, and 1025 of them and the 1025 code points in 513 clusters
//   refused. Code: every other character in an edit (MessagesManager.cpp:23805-23806).
// A longer text goes as text messages with only spaces and line breaks trimmed at its edges; one empty as a caption
// sends nothing, refused as a text message by code (MessageEntity.cpp:4513-4520 and :4574-4577).
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
