// The parse half of rich.js: what Telegram is sent for a reply, and where a
// long reply is cut. AXEG0/claude-telegram's rich.ts, ported with the same
// parser (markdown-parser.js). The rich worker loads it; see richPartsAsync.

import { parseMarkdown } from './markdown-parser.js'
import { RICH_PART_BLOCKS, RICH_PART_BYTES } from './rich.js'

// The HTML tags a rich message renders (Bot API, Rich HTML style). Telegram
// drops any other tag and keeps its content, so "Vec<String>" arrived as
// "Vec". A name that is not HTML, such as a type parameter, goes out as &lt;;
// a lowercase HTML element such as <kbd> is left for Telegram to drop.
const RICH_TAGS = new Set([
  'a', 'aside', 'audio', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'del', 'details', 'em',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins',
  'li', 'mark', 'ol', 'p', 'pre', 's', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'video',
  'tg-button', 'tg-button-row', 'tg-collage', 'tg-document', 'tg-emoji', 'tg-map', 'tg-math',
  'tg-math-block', 'tg-reference', 'tg-slideshow', 'tg-spoiler', 'tg-thinking', 'tg-time',
])

const HTML_TAGS = new Set([
  'abbr', 'address', 'article', 'bdi', 'bdo', 'big', 'button', 'center', 'col', 'colgroup', 'data', 'dd',
  'dfn', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'font', 'form', 'header', 'iframe', 'kbd', 'label',
  'legend', 'main', 'meter', 'nav', 'object', 'option', 'progress', 'q', 'rp', 'rt', 'ruby', 'samp',
  'section', 'select', 'small', 'source', 'span', 'svg', 'textarea', 'time', 'tt', 'var', 'wbr',
])

// Containers whose html children are blocks; under any other parent html is inline.
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

const startOf = node => node.position?.start.offset ?? 0
const endOf = node => node.position?.end.offset ?? 0

// Telegram reads Markdown inside <details>, while CommonMark reads a line
// that starts with <details> or <summary> as an HTML block running to the
// next blank line, so a summary on its own line went out unescaped. The parse
// therefore reads a tag that ends its line as a blank line, as Telegram ends
// a block there (an indented line after it is code), and any other tag as an
// inert word of the same length, which keeps the indentation of the text
// after it and so the lists and quotes around it. The tags are found round by
// round, as each one settles the blocks after it; tags in code are dropped.
// Offsets stay those of md, and the tags are sent as written.
// A tag is { from, to, open }: open is +1 for <details>, -1 for </details>,
// 0 for summary.
function parseLikeTelegram(md) {
  let root = parseMarkdown(md)
  const tags = []
  if (!/<\/?(details|summary)\b/i.test(md)) return { root, tags }
  let view = md
  for (let round = 0; round < 8; round++) {
    const found = []
    const visit = (node, parent) => {
      if (node.type === 'html') {
        // Inline, or a block whose content is never Markdown: <pre>, a comment.
        if (parent && !FLOW_PARENTS.has(parent.type)) return
        if (/^\s*<(pre|script|style|textarea)\b|^\s*<!/i.test(node.value)) return
        const from = startOf(node)
        for (const m of view.slice(from, endOf(node)).matchAll(/<(\/?)(details|summary)\b[^>]*>/gi)) {
          const at = from + m.index
          found.push({ from: at, to: at + m[0].length, open: m[2].toLowerCase() === 'summary' ? 0 : m[1] ? -1 : 1 })
        }
        return
      }
      if ('children' in node) for (const child of node.children) visit(child, node)
    }
    visit(root, undefined)
    if (found.length === 0) break
    found.sort((a, b) => a.from - b.from)
    let next = ''
    let at = 0
    for (const t of found) {
      const tag = view.slice(t.from, t.to)
      const endsLine = !/[\r\n]/.test(tag) && /^[ \t]*(\r|\n|$)/.test(view.slice(t.to, t.to + 200))
      next += view.slice(at, t.from) + (endsLine ? ' '.repeat(tag.length - 1) + '\n' : tag.replace(/[^\r\n]/g, 'x'))
      at = t.to
    }
    view = next + view.slice(at)
    tags.push(...found)
    root = parseMarkdown(view)
  }
  const code = []
  const inCode = node => {
    if (node.type === 'code' || node.type === 'inlineCode') code.push([startOf(node), endOf(node)])
    else if ('children' in node) for (const child of node.children) inCode(child)
  }
  inCode(root)
  return { root, tags: tags.filter(t => !code.some(([a, b]) => t.from >= a && t.from < b)).sort((a, b) => a.from - b.from) }
}

// What Telegram would misread in md, by source offset. A $ in text can open a
// formula ("path $HOME/$USER" became math), so it gets a backslash. Only text
// nodes are touched: in code, autolinks and link URLs the backslash would
// show. A tag Telegram does not render becomes &lt;. An edit is
// { drop, insert, gap }: drop the source character or not, and insert before
// it; gap marks a blank line above a table, which a part carries only when it
// still fits every limit with it (Rendered.part).
function collectEdits(md, root, tags) {
  const edits = new Map()
  const walk = (node, parent) => {
    switch (node.type) {
      case 'text':
        for (let i = startOf(node); i < endOf(node); i++) {
          if (md[i] === '\\') i++
          else if (md[i] === '$') edits.set(i, { drop: 0, insert: '\\' })
        }
        return
      case 'html': {
        if (!parent || FLOW_PARENTS.has(parent.type)) return
        const at = startOf(node)
        const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(md.slice(at, at + 64))?.[1]
        if (name && !RICH_TAGS.has(name.toLowerCase()) && !HTML_TAGS.has(name)) edits.set(at, { drop: 1, insert: '&lt;' })
        return
      }
      case 'link':
        if (md[startOf(node)] === '<') return
        break
    }
    if ('children' in node) for (const child of node.children) walk(child, node)
  }
  walk(root, undefined)
  tableGaps(md, root, tags, edits)
  return edits
}

// Telegram's limits on a table's columns and on levels of nested formatting
// and blocks (Bot API, Rich Message Limits).
const TABLE_COLUMNS = 20
const RICH_LEVELS = 16
const SECTION_TAG = /<\/?(details|summary)\b/i
// The HTML tags the page builds text from (Rich HTML style); <a> is not one,
// as the page also builds a block from <a name>. A table cell holds text only
// (RichBlockTableCell), so how Telegram reads any other tag there, or a
// Markdown image, which can be a photo, video or other media block, is not known.
const TEXT_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'mark', 'sub', 'sup', 'br',
  'tg-spoiler', 'tg-reference', 'tg-emoji', 'tg-time', 'tg-math', 'tg-button',
])
// A backslash escape, which GFM reads as text.
const ESCAPED = /\\[!-\/:-@[-`{-~]/g
// Tags that close nothing: HTML's void elements, and any tag written as <x/>.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

// Every tag of raw HTML Telegram reads as a tag, in source order, none sent as
// &lt;, each { at, name, open, void }. Of the <details> and <summary> tags read
// above, which the parse no longer holds, the summary tags. A comment is one
// entry named '!', which no cell may hold; how Telegram reads its inside was
// never sent, so each tag there counts as an element opened, closed only by a
// later closing tag of its name while it is the innermost open element. A tag
// ends at the first '>', so a node is read only up to its last '>': a '<' after
// it starts no tag, and each '<' before it is read once, which keeps a long
// node linear.
function htmlTags(md, root, tags, edits) {
  const out = tags.filter(t => t.open === 0).map(t => ({ at: t.from, name: 'summary', open: md[t.from + 1] !== '/', void: false }))
  const read = (from, text) => {
    for (const m of text.slice(0, text.lastIndexOf('>') + 1).matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>|<[!?][^>]*>/g)) {
      const at = from + m.index
      if (m[2] === undefined) out.push({ at, name: '!', open: true, void: true })
      else if (edits.get(at)?.insert !== '&lt;') out.push({ at, name: m[2].toLowerCase(), open: !m[1], void: VOID_TAGS.has(m[2].toLowerCase()) || !!m[3] })
    }
  }
  const walk = node => {
    if (node.type === 'html') {
      const from = startOf(node), text = md.slice(from, endOf(node))
      let at = 0
      for (let c = text.indexOf('<!--'); c >= 0; c = text.indexOf('<!--', at)) {
        read(from + at, text.slice(at, c))
        out.push({ at: from + c, name: '!', open: true, void: true })
        const end = text.indexOf('-->', c + 4)
        at = end < 0 ? text.length : end + 3
        const n = out.length
        read(from + c + 4, text.slice(c + 4, end < 0 ? text.length : end))
        for (let i = n; i < out.length; i++) out[i] = { ...out[i], open: true, void: false }
      }
      read(from + at, text.slice(at))
      return
    }
    if ('children' in node) for (const child of node.children) walk(child)
  }
  walk(root)
  return out.sort((a, b) => a.at - b.at)
}

// Telegram reads a table right under a paragraph as that paragraph's text;
// one blank line, with the container's quote markers, lets it start a table.
// The line goes in only where what Telegram reads is known: no lone CR, and
// inside <details> only as sent live. The table it makes stays within
// Telegram's columns and levels, counted with every level it may count.
function tableGaps(md, root, tags, edits) {
  const html = htmlTags(md, root, tags, edits)
  // The index of the first tag at or after at.
  const first = at => {
    let lo = 0, hi = html.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (html[mid].at < at) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const within = (from, to) => html.slice(first(from), first(to))
  // opened[i]: how many elements of raw HTML stand open before html[i], such
  // as a collage or a quote written as a tag, whose reading of a table inside
  // was never sent. A closing tag closes the innermost element, and only when
  // it names it; any other closing tag closes nothing.
  const opened = [0]
  const stack = []
  for (const t of html) {
    if (!t.void && t.open) stack.push(t.name)
    else if (!t.void && stack.at(-1) === t.name) stack.pop()
    opened.push(stack.length)
  }
  const inside = at => opened[first(at)] > 0
  // Whether the tags in [from, to) close every tag they open, and only those.
  const closed = (from, to) => {
    const stack = []
    for (const t of within(from, to)) {
      if (t.void) continue
      if (t.open) stack.push(t.name)
      else if (stack.pop() !== t.name) return false
    }
    return stack.length === 0
  }
  // Whether the line would split what Telegram reads as one: in main's text
  // the paragraph and table are one paragraph, so a tag, a == or a || pair
  // can open in one block or cell and close in another. Each text is read
  // each way Telegram may read it: as written, with its backslash escapes as
  // text, and as the parse decodes it, as GFM reads an escaped | in a cell. A
  // character reference holds no = or |. Three or more = or | in a row were
  // never sent. The counts of == and of || in each reading, summed over the
  // block or cell, or none for a run of three.
  const count = s => /={3}|\|{3}/.test(s) ? undefined : [s.split('==').length - 1, s.split('||').length - 1]
  const marks = n => {
    if (n.type === 'text') {
      const raw = md.slice(startOf(n), endOf(n))
      const r = [count(raw), count(raw.replace(ESCAPED, m => ' '.repeat(m.length))), count(n.value)]
      return r.every(Boolean) ? r.flat() : undefined
    }
    let sum = [0, 0, 0, 0, 0, 0]
    if ('children' in n) for (const c of n.children) {
      const m = marks(c)
      if (!m) return undefined
      sum = sum.map((x, i) => x + m[i])
    }
    return sum
  }
  const whole = n => closed(startOf(n), endOf(n)) && !!marks(n)?.every(c => c % 2 === 0)
  // A cell holds text only: no image, and no tag the page builds no text from.
  const media = n =>
    n.type === 'image' || n.type === 'imageReference' || ('children' in n && n.children.some(media))
  // A || between two cells is a cell boundary to GFM and a spoiler's mark to
  // Telegram in main's text, where the table is paragraph text.
  const pipes = table => md.slice(startOf(table), endOf(table)).includes('||')
  const textOnly = table => !media(table) && within(startOf(table), endOf(table)).every(t => TEXT_TAGS.has(t.name)) &&
    table.children.every(row => row.children.every(whole)) && !pipes(table)
  const lone = (from, to) => {
    for (let i = from; i <= to; i++) if (md[i] === '\r' && md[i + 1] !== '\n') return true
    return false
  }
  const lineStart = at => at === 0 || md[at - 1] === '\n' || md[at - 1] === '\r'
  const visit = (node, levels) => {
    if (!('children' in node) || node.type === 'footnoteDefinition') return
    const kids = node.children
    for (let k = 1; k < kids.length; k++) {
      const prev = kids[k - 1], table = kids[k]
      if (table.type !== 'table' || prev.type !== 'paragraph') continue
      const from = startOf(prev), to = endOf(table)
      if (lone(from, to) || SECTION_TAG.test(md.slice(from, to)) || inside(from) || !whole(prev) || !textOnly(table)) continue
      // The <details> sections open at the paragraph, innermost last.
      const open = []
      for (const t of tags) {
        if (t.from >= from) break
        if (t.open === 1) open.push(t)
        else if (t.open === -1) open.pop()
      }
      if (open.length > 0) {
        const close = tags.find(t => t.from >= to)
        if (node.type !== 'root' || open.length !== 1 || !lineStart(open[0].from)) continue
        if (!close || close.open !== -1 || !lineStart(close.from) || SECTION_TAG.test(md.slice(from, close.from))) continue
      }
      let columns = 0
      for (const row of table.children) columns = Math.max(columns, row.children.length)
      if (columns > TABLE_COLUMNS || levels + open.length + tableLevels(table) > RICH_LEVELS) continue
      // The delimiter row: the line after the head row's LF or CRLF.
      let e = startOf(table)
      while (e < md.length && md[e] !== '\n' && md[e] !== '\r') e++
      const d = /^[ \t>]*/.exec(md.slice(e + (md[e] === '\r' ? 2 : 1)))[0]
      // A list marker that cannot interrupt a paragraph (an ordered one not numbered 1, or an empty item)
      // opens a list once a blank line is above it, so that head row keeps main's text.
      if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(md.slice(startOf(table), e))) continue
      const gap = /^(\r\n|\n)([ \t>]*)$/.exec(md.slice(endOf(prev), startOf(table)))
      if (!gap || gap[2] !== d) continue
      edits.set(endOf(prev), { drop: 0, insert: gap[1] + d.replace(/[ \t]+$/, ''), gap: true })
    }
    for (const c of kids) visit(c, levels + 1)
  }
  visit(root, 0)
}

// The levels a table takes, each one Telegram may count: the table, a row, a
// cell, then the cell's formatting, each node of it one. A footnote reference
// is two, as Telegram makes it a superscript holding a link. A text is one,
// for an entity Telegram may find in it (a mention, hashtag, cashtag, command,
// link, e-mail, phone or card number; none sits inside another). Each tag of
// raw HTML is one more, and so is each == or || in a text, which Telegram
// reads as marked text or a spoiler where GFM reads neither.
function tableLevels(table) {
  const nest = n => {
    if (n.type === 'html') return 0
    if (n.type === 'text') return 1
    if (n.type === 'footnoteReference') return 2
    let most = 0
    if ('children' in n) for (const c of n.children) most = Math.max(most, nest(c))
    return 1 + most
  }
  const more = n => {
    if (n.type === 'html') return n.value.split('<').length - 1
    if (n.type === 'text') return n.value.split(/==|\|\|/).length - 1
    let sum = 0
    if ('children' in n) for (const c of n.children) sum += more(c)
    return sum
  }
  let most = 0
  for (const row of table.children) for (const cell of row.children) most = Math.max(most, nest(cell) - 1 + more(cell))
  return 3 + most
}

// Node types that are no block of Telegram's: text, its formatting, a table
// cell (table rows count). Raw HTML and images are counted apart.
const NOT_BLOCKS = new Set([
  'text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link', 'linkReference',
  'footnoteReference', 'tableCell',
])

// The rich Markdown Telegram is sent for md, whole, with every blank line
// above a table.
export function richMarkdown(md) {
  const { root, tags } = parseLikeTelegram(md)
  return new Rendered(md, root, tags).render(0, md.length, true)
}

const isHigh = c => c >= 0xd800 && c < 0xdc00
const isLow = c => c >= 0xdc00 && c < 0xe000

class Rendered {
  constructor(md, root, tags) {
    this.md = md
    this.edits = collectEdits(md, root, tags)
    // bytes[i] is the UTF-8 size of what md[0, i) renders to, without the blank
    // lines above tables, so every cut falls where it falls without them. A lone
    // surrogate goes out as U+FFFD, 3 bytes. gaps[i] is the size those lines
    // add. blocks[i] counts the blocks starting in md[0, i) as Telegram's page
    // counts them toward its limit: nested blocks, list items, table rows,
    // quotes and <details> sections included, and two per image or tag of raw
    // HTML, a Markdown image inside raw HTML included: each opens at most one
    // block, a media block for an image, and the text after it one paragraph.
    this.bytes = new Uint32Array(md.length + 1)
    this.gaps = new Uint32Array(md.length + 1)
    this.blocks = new Uint32Array(md.length + 1)
    const starts = new Uint32Array(md.length + 1)
    const count = node => {
      if (node.type === 'html') starts[startOf(node)] += 2 * (node.value.split(/<|!\[/).length - 1)
      else if (node.type === 'image' || node.type === 'imageReference') starts[startOf(node)] += 2
      else if (node.type !== 'root' && !NOT_BLOCKS.has(node.type)) starts[startOf(node)]++
      if ('children' in node) for (const child of node.children) count(child)
    }
    count(root)
    for (const t of tags) if (t.open === 1) starts[t.from]++
    for (let i = 0; i < md.length; i++) {
      const c = md.charCodeAt(i)
      let n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3
      if (isHigh(c) && isLow(md.charCodeAt(i + 1))) n = 4
      else if (isLow(c) && isHigh(md.charCodeAt(i - 1))) n = 0
      const e = this.edits.get(i)
      const g = e?.gap ? Buffer.byteLength(e.insert) : 0
      if (e && !e.gap) n = Buffer.byteLength(e.insert) + (e.drop ? 0 : n)
      this.bytes[i + 1] = this.bytes[i] + n
      this.gaps[i + 1] = this.gaps[i] + g
      this.blocks[i + 1] = this.blocks[i] + starts[i]
    }
  }
  size(from, to) {
    return this.bytes[to] - this.bytes[from]
  }
  // The rich Markdown for md[from, to), with its blank lines above tables
  // only when gaps is set.
  render(from, to, gaps = false) {
    let out = ''
    let at = from
    for (let i = from; i < to; i++) {
      const e = this.edits.get(i)
      if (!e || (e.gap && !gaps)) continue
      out += this.md.slice(at, i) + e.insert
      at = i + e.drop
    }
    return out + this.md.slice(at, to)
  }
  // The part for md[from, to). It carries its blank lines above tables only
  // when, with them, it stays within bytes and within the block budget of a
  // reply's part, counting reopened, a container a cut opens again; else its
  // rich Markdown is the text without them, as main sends it.
  part(from, to, bytes, reopened = 0) {
    const added = this.gaps[to] - this.gaps[from]
    const fits = this.size(from, to) + added <= bytes && this.blocks[to] - this.blocks[from] + reopened <= RICH_PART_BLOCKS
    return { rich: this.render(from, to, added > 0 && fits), plain: this.md.slice(from, to) }
  }
}

// One message of a long reply is { rich, plain }: the text as written, and
// the rich Markdown for it, unless only plain text keeps it whole.
// Limits are { bytes, blocks }. A span is { from, to, blocks, node, whole }.

// Splits md into rich messages between top-level blocks, never inside a
// <details>. The spans cover md end to end, so no text is lost or sent twice.
// A block too big alone is cut where Markdown allows it: a code block is
// closed and reopened, a table repeats its header, a list or quote is cut
// between its items. Anything else that big goes out plain, as written.
export function richParts(md, limits = { bytes: RICH_PART_BYTES, blocks: RICH_PART_BLOCKS }) {
  const { root, tags } = parseLikeTelegram(md)
  const r = new Rendered(md, root, tags)
  const starts = []
  let depth = 0
  let floor = 0
  let t = 0
  let lastEnd = 0
  const open = (at, node) => {
    let from = at
    while (from > floor && md[from - 1] !== '\n' && md[from - 1] !== '\r') from--
    const last = starts.at(-1)
    if (last && from <= last.from) from = last.from
    if (last && from === last.from) {
      last.whole = false
      return last
    }
    const span = { from, to: md.length, blocks: 0, node, whole: true }
    if (last) last.to = from
    starts.push(span)
    return span
  }
  for (const node of root.children) {
    const at = startOf(node)
    for (; t < tags.length && tags[t].from < at; t++) {
      const tag = tags[t]
      // A <details> inside the last block, such as a list item, is part of it.
      if (tag.open === 1 && depth === 0 && tag.from >= lastEnd) open(tag.from).whole = false
      depth = Math.max(0, depth + tag.open)
      floor = tag.to
    }
    const span = depth === 0 ? open(at, node) : starts.at(-1)
    lastEnd = Math.max(lastEnd, endOf(node))
    if (!span) continue
    span.blocks++
    if (span.node !== node) span.whole = false
  }
  for (; t < tags.length; t++) {
    const tag = tags[t]
    if (tag.open === 1 && depth === 0 && tag.from >= lastEnd) open(tag.from).whole = false
    depth = Math.max(0, depth + tag.open)
  }
  if (starts.length === 0) return [{ rich: md, plain: md }]
  starts[0].from = 0

  const parts = []
  let cur
  const flush = () => {
    if (cur) parts.push(r.part(cur.from, cur.to, limits.bytes))
    cur = undefined
  }
  for (const s of starts) {
    const [from, to] = trim(md, s.from, s.to)
    if (from >= to) continue
    if (cur && r.size(cur.from, to) <= limits.bytes && cur.blocks + s.blocks <= limits.blocks) {
      cur.to = to
      cur.blocks += s.blocks
      continue
    }
    flush()
    if (r.size(from, to) <= limits.bytes) cur = { from, to, blocks: s.blocks }
    else parts.push(...cutBlock(r, from, to, s.whole ? s.node : undefined, limits))
  }
  flush()
  return parts
}

// [from, to) without its leading blank lines and trailing whitespace.
function trim(md, from, to) {
  for (let i = from; i < to; i++) {
    if (md[i] === '\n' || md[i] === '\r') from = i + 1
    else if (md[i] !== ' ' && md[i] !== '\t') break
  }
  while (to > from && ' \t\r\n'.includes(md[to - 1])) to--
  return [from, to]
}

function lines(md, from, to) {
  const out = []
  for (let s = from; s <= to; ) {
    let e = s
    while (e < to && md[e] !== '\n' && md[e] !== '\r') e++
    out.push([s, e])
    s = e + (md[e] === '\r' && md[e + 1] === '\n' ? 2 : 1)
  }
  return out
}

function cutBlock(r, from, to, node, limits) {
  const md = r.md
  const plain = [{ plain: md.slice(from, to) }]
  if (node?.type === 'list' || node?.type === 'blockquote') {
    // Each item or quoted block starts on its own line, prefix included.
    const kids = []
    for (const child of node.children) {
      let at = startOf(child)
      while (at > from && md[at - 1] !== '\n' && md[at - 1] !== '\r') at--
      const last = kids.at(-1)
      if (last && at <= last.from) continue
      if (last) last.to = at
      kids.push({ from: kids.length ? at : from, to, blocks: 1, whole: true })
    }
    const out = []
    let cur
    for (const k of kids) {
      const [a, b] = trim(md, k.from, k.to)
      if (a >= b) continue
      if (cur && r.size(cur[0], b) <= limits.bytes) {
        cur[1] = b
        continue
      }
      if (cur) out.push(r.part(cur[0], cur[1], limits.bytes, startOf(node) < cur[0] ? 1 : 0))
      cur = undefined
      if (r.size(a, b) <= limits.bytes) cur = [a, b]
      else out.push({ plain: md.slice(a, b) })
    }
    if (cur) out.push(r.part(cur[0], cur[1], limits.bytes, startOf(node) < cur[0] ? 1 : 0))
    return out
  }

  let body = lines(md, from, to)
  let head
  let tail = ''
  let hardCut = false
  const fence = node?.type === 'code' ? /^ {0,3}(`{3,}|~{3,})/.exec(md.slice(from, to))?.[1] : undefined
  if (fence) {
    head = body.shift()
    const last = body.at(-1)
    const close = last && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(md.slice(last[0], last[1]))?.[1]
    if (close && close[0] === fence[0] && close.length >= fence.length) body.pop()
    tail = fence
    hardCut = true
  } else if (node?.type === 'table' && body.length > 2) {
    head = [body[0][0], body[1][1]]
    body = body.slice(2)
  } else if (node?.type !== 'code') return plain

  const headSize = head ? r.size(head[0], head[1]) + 1 : 0
  const room = limits.bytes - headSize - (tail ? tail.length + 1 : 0)
  if (room < limits.bytes / 2) return plain
  const wrap = (a, b) => {
    const join = (pre, mid) => (pre === undefined ? mid : `${pre}\n${mid}`) + (tail ? `\n${tail}` : '')
    return {
      rich: join(head && r.render(head[0], head[1]), r.render(a, b)),
      plain: join(head && md.slice(head[0], head[1]), md.slice(a, b)),
    }
  }
  const out = []
  let start
  let end = 0
  for (const [a, b] of body) {
    if (start !== undefined && r.size(start, b) <= room) {
      end = b
      continue
    }
    if (start !== undefined) out.push(wrap(start, end))
    start = a
    end = b
    // Inside a fence a line too long alone is cut by size; a low surrogate
    // costs no bytes, so the cut never lands inside a pair. Elsewhere a cut
    // line would change what it is, so the block goes out plain.
    if (r.size(start, end) > room && !hardCut) return plain
    while (r.size(start, end) > room) {
      let cut = start + 1
      while (cut < end && r.size(start, cut + 1) <= room) cut++
      out.push(wrap(start, cut))
      start = cut
    }
  }
  if (start !== undefined) out.push(wrap(start, end))
  return out
}
