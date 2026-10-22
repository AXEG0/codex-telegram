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
// { drop, insert }: drop the source character or not, and insert before it.
function collectEdits(md, root) {
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
  return edits
}

// The rich Markdown Telegram is sent for md, whole.
export function richMarkdown(md) {
  return new Rendered(md, parseLikeTelegram(md).root).render(0, md.length)
}

const isHigh = c => c >= 0xd800 && c < 0xdc00
const isLow = c => c >= 0xdc00 && c < 0xe000

class Rendered {
  constructor(md, root) {
    this.md = md
    this.edits = collectEdits(md, root)
    // bytes[i] is the UTF-8 size of what md[0, i) renders to. A lone surrogate
    // goes out as U+FFFD, 3 bytes.
    this.bytes = new Uint32Array(md.length + 1)
    for (let i = 0; i < md.length; i++) {
      const c = md.charCodeAt(i)
      let n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3
      if (isHigh(c) && isLow(md.charCodeAt(i + 1))) n = 4
      else if (isLow(c) && isHigh(md.charCodeAt(i - 1))) n = 0
      const e = this.edits.get(i)
      if (e) n = Buffer.byteLength(e.insert) + (e.drop ? 0 : n)
      this.bytes[i + 1] = this.bytes[i] + n
    }
  }
  size(from, to) {
    return this.bytes[to] - this.bytes[from]
  }
  render(from, to) {
    let out = ''
    let at = from
    for (let i = from; i < to; i++) {
      const e = this.edits.get(i)
      if (!e) continue
      out += this.md.slice(at, i) + e.insert
      at = i + e.drop
    }
    return out + this.md.slice(at, to)
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
  const r = new Rendered(md, root)
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
    if (cur) parts.push({ rich: r.render(cur.from, cur.to), plain: md.slice(cur.from, cur.to) })
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
      if (cur) out.push({ rich: r.render(cur[0], cur[1]), plain: md.slice(cur[0], cur[1]) })
      cur = undefined
      if (r.size(a, b) <= limits.bytes) cur = [a, b]
      else out.push({ plain: md.slice(a, b) })
    }
    if (cur) out.push({ rich: r.render(cur[0], cur[1]), plain: md.slice(cur[0], cur[1]) })
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
