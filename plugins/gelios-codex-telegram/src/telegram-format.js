const TELEGRAM_TEXT_LIMIT = 4096
const TELEGRAM_ENTITY_LIMIT = 90
const FORMATTING_TYPES = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler'])
const CODE_TYPES = new Set(['code', 'pre'])

function message(text = '', entities = []) {
  return { text, entities }
}

function append(target, value) {
  if (!value) return
  if (typeof value === 'string') {
    target.text += value
    return
  }
  const offset = target.text.length
  target.text += value.text
  target.entities.push(...value.entities.map(entity => ({ ...entity, offset: entity.offset + offset })))
}

function styled(type, value, extra = {}) {
  if (!value.text) return value
  return message(value.text, [{ type, offset: 0, length: value.text.length, ...extra }, ...value.entities])
}

function escapedAt(value, index) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function validDelimiterClose(value, index) {
  return index > 0 && !/\s/u.test(value[index - 1])
}

function findClosingDelimiter(value, marker, start) {
  let index = value.indexOf(marker, start)
  while (index >= 0) {
    if (index > start && !escapedAt(value, index) && validDelimiterClose(value, index)) return index
    index = value.indexOf(marker, index + marker.length)
  }
  return -1
}

function findMatching(value, start, opener, closer) {
  let depth = 0
  for (let index = start; index < value.length; index += 1) {
    if (escapedAt(value, index)) continue
    if (value[index] === opener) depth += 1
    else if (value[index] === closer) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function markdownDestination(raw) {
  const value = raw.trim()
  const match = /^(?:<([^>]*)>|([^\s]+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/su.exec(value)
  const destination = (match?.[1] ?? match?.[2] ?? '').replace(/\\([\\()[\]])/g, '$1')
  if (!destination) return null
  try {
    const url = new URL(destination)
    return ['http:', 'https:', 'tg:'].includes(url.protocol) ? destination : null
  } catch {
    return null
  }
}

function renderLink(value, index, depth) {
  const image = value.startsWith('![', index)
  const labelStart = index + (image ? 2 : 1)
  const labelEnd = findMatching(value, labelStart - 1, '[', ']')
  if (labelEnd < 0 || value[labelEnd + 1] !== '(') return null
  const destinationEnd = findMatching(value, labelEnd + 1, '(', ')')
  if (destinationEnd < 0) return null
  const rawDestination = value.slice(labelEnd + 2, destinationEnd)
  const url = markdownDestination(rawDestination)
  const label = renderInline(value.slice(labelStart, labelEnd), depth + 1, false)
  const raw = rawDestination.trim()
  const visible = image
    ? message(`🖼${label.text ? ` ${label.text}` : ''}`, label.entities.map(entity => ({ ...entity, offset: entity.offset + 3 })))
    : label.text ? label : message(url || raw)
  if (!visible.text) return null
  if (!url) {
    return { value: message(`${visible.text}${raw ? ` (${raw})` : ''}`, visible.entities), end: destinationEnd + 1 }
  }
  return { value: styled('text_link', visible, { url }), end: destinationEnd + 1 }
}

function renderCodeSpan(value, index) {
  let size = 1
  while (value[index + size] === '`') size += 1
  const marker = '`'.repeat(size)
  const end = value.indexOf(marker, index + size)
  if (end < 0) return null
  let content = value.slice(index + size, end).replace(/[\r\n]+/g, ' ')
  if (/^\s[\s\S]*\s$/u.test(content) && !/^\s+$/u.test(content)) content = content.slice(1, -1)
  return { value: styled('code', message(content)), end: end + size }
}

function renderDelimited(value, index, marker, types, depth) {
  if (!value.startsWith(marker, index)) return null
  const next = value[index + marker.length]
  if (!next || /\s/u.test(next)) return null
  if (marker === '_' && /[\p{L}\p{N}]/u.test(value[index - 1] || '') && /[\p{L}\p{N}]/u.test(next)) return null
  const end = findClosingDelimiter(value, marker, index + marker.length)
  if (end < 0) return null
  if (marker === '_' && /[\p{L}\p{N}]/u.test(value[end - 1] || '') && /[\p{L}\p{N}]/u.test(value[end + 1] || '')) return null
  let rendered = renderInline(value.slice(index + marker.length, end), depth + 1)
  for (const type of types) rendered = styled(type, rendered)
  return { value: rendered, end: end + marker.length }
}

function renderInline(value, depth = 0, allowLinks = true) {
  if (depth > 32) return message(value)
  const output = message()
  for (let index = 0; index < value.length;) {
    if (value[index] === '\\' && index + 1 < value.length && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(value[index + 1])) {
      append(output, value[index + 1]); index += 2; continue
    }
    if (value[index] === '`') {
      const code = renderCodeSpan(value, index)
      if (code) { append(output, code.value); index = code.end; continue }
    }
    if (allowLinks && (value[index] === '[' || value.startsWith('![', index))) {
      const link = renderLink(value, index, depth)
      if (link) { append(output, link.value); index = link.end; continue }
    }
    if (value[index] === '<') {
      const autolink = /^<(https?:\/\/[^>\s]+|tg:\/\/[^>\s]+)>/u.exec(value.slice(index))
      if (autolink) {
        append(output, styled('text_link', message(autolink[1]), { url: autolink[1] }))
        index += autolink[0].length; continue
      }
      const br = /^<br\s*\/?>/iu.exec(value.slice(index))
      if (br) { append(output, '\n'); index += br[0].length; continue }
    }
    const candidates = [
      ['***', ['bold', 'italic']],
      ['___', ['bold', 'italic']],
      ['**', ['bold']],
      ['__', ['bold']],
      ['~~', ['strikethrough']],
      ['||', ['spoiler']],
      ['*', ['italic']],
      ['_', ['italic']],
    ]
    let formatted = null
    for (const [marker, types] of candidates) {
      formatted = renderDelimited(value, index, marker, types, depth)
      if (formatted) break
    }
    if (formatted) { append(output, formatted.value); index = formatted.end; continue }
    append(output, value[index]); index += 1
  }
  return output
}

function tableCells(line) {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !escapedAt(value, value.length - 1)) value = value.slice(0, -1)
  const cells = []
  let cell = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '|' && !escapedAt(value, index)) {
      cells.push(renderInline(cell.trim()).text); cell = ''; continue
    }
    cell += value[index]
  }
  cells.push(renderInline(cell.trim()).text)
  return cells
}

function tableDelimiter(line) {
  const cells = tableCells(line)
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/u.test(cell))
}

function renderTable(lines) {
  const rows = lines.map(tableCells)
  const columns = Math.max(...rows.map(row => row.length))
  const widths = Array.from({ length: columns }, (_, column) => Math.min(40, Math.max(...rows.map(row => (row[column] || '').length))))
  const text = rows.map(row => widths.map((width, column) => (row[column] || '').slice(0, width).padEnd(width)).join('  ').trimEnd()).join('\n')
  return styled('pre', message(text))
}

function renderLine(line) {
  const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u.exec(line)
  if (heading) return styled('bold', renderInline(heading[1]))
  if (/^ {0,3}(?:\*\s*){3,}$/u.test(line) || /^ {0,3}(?:-\s*){3,}$/u.test(line) || /^ {0,3}(?:_\s*){3,}$/u.test(line)) {
    return message('──────────')
  }
  const unordered = /^(\s*)[-+*][ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/u.exec(line)
  if (unordered) {
    const depth = Math.min(6, Math.floor(unordered[1].replace(/\t/g, '  ').length / 2))
    const bullet = unordered[2] == null ? '•' : unordered[2].toLowerCase() === 'x' ? '☑' : '☐'
    const output = message(`${'  '.repeat(depth)}${bullet} `)
    append(output, renderInline(unordered[3]))
    return output
  }
  const ordered = /^(\s*)(\d+)[.)][ \t]+(.*)$/u.exec(line)
  if (ordered) {
    const depth = Math.min(6, Math.floor(ordered[1].replace(/\t/g, '  ').length / 2))
    const output = message(`${'  '.repeat(depth)}${ordered[2]}. `)
    append(output, renderInline(ordered[3]))
    return output
  }
  return renderInline(line)
}

function excludeRanges(entity, ranges) {
  let spans = [[entity.offset, entity.offset + entity.length]]
  for (const [rangeStart, rangeEnd] of ranges) {
    spans = spans.flatMap(([start, end]) => {
      if (rangeEnd <= start || rangeStart >= end) return [[start, end]]
      return [[start, Math.max(start, rangeStart)], [Math.min(end, rangeEnd), end]].filter(([left, right]) => right > left)
    })
  }
  return spans.map(([start, end]) => ({ ...entity, offset: start, length: end - start }))
}

function normalizeEntities(text, entities) {
  const valid = entities.filter(entity => Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length)
  const codeRanges = valid.filter(entity => CODE_TYPES.has(entity.type)).map(entity => [entity.offset, entity.offset + entity.length])
  const codeSafe = valid.flatMap(entity => CODE_TYPES.has(entity.type) ? [entity] : excludeRanges(entity, codeRanges))
  const exclusive = codeSafe
    .filter(entity => !FORMATTING_TYPES.has(entity.type) && !CODE_TYPES.has(entity.type))
    .sort((left, right) => (left.type === 'text_link' ? -1 : 0) - (right.type === 'text_link' ? -1 : 0) || left.offset - right.offset || right.length - left.length)
  const acceptedExclusive = []
  for (const entity of exclusive) {
    const occupied = acceptedExclusive.map(item => [item.offset, item.offset + item.length])
    acceptedExclusive.push(...excludeRanges(entity, occupied))
  }
  const nestingSafe = [
    ...codeSafe.filter(entity => FORMATTING_TYPES.has(entity.type) || CODE_TYPES.has(entity.type)),
    ...acceptedExclusive,
  ]
  const unique = new Map()
  for (const entity of nestingSafe) {
    const key = JSON.stringify([entity.type, entity.offset, entity.length, entity.url || null, entity.language || null])
    unique.set(key, entity)
  }
  const sorted = [...unique.values()].sort((left, right) => left.offset - right.offset || right.length - left.length || left.type.localeCompare(right.type))
  const merged = []
  for (const entity of sorted) {
    const previous = merged.at(-1)
    const same = previous && previous.type === entity.type && previous.url === entity.url && previous.language === entity.language
    if (same && previous.offset + previous.length === entity.offset && (FORMATTING_TYPES.has(entity.type) || CODE_TYPES.has(entity.type))) previous.length += entity.length
    else merged.push({ ...entity })
  }
  return merged
}

export function renderTelegramMarkdown(markdown) {
  const source = String(markdown).replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const output = message()
  for (let index = 0; index < lines.length;) {
    let rendered
    let consumed = 1
    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)?.*$/u.exec(lines[index])
    if (fence) {
      const marker = fence[1]
      let end = index + 1
      while (end < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, 'u').test(lines[end])) end += 1
      const content = lines.slice(index + 1, end).join('\n')
      const language = (fence[2] || '').replace(/[^A-Za-z0-9_+.-]/g, '').slice(0, 64)
      rendered = styled('pre', message(content), language ? { language } : {})
      consumed = end < lines.length ? end - index + 1 : lines.length - index
    } else if (index + 1 < lines.length && lines[index].trim() && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1])) {
      rendered = styled('bold', renderInline(lines[index].trim()))
      consumed = 2
    } else if (index + 1 < lines.length && tableCells(lines[index]).length > 1 && tableDelimiter(lines[index + 1])) {
      let end = index + 2
      while (end < lines.length && tableCells(lines[end]).length > 1 && lines[end].trim()) end += 1
      rendered = renderTable([lines[index], ...lines.slice(index + 2, end)])
      consumed = end - index
    } else if (/^ {0,3}>/u.test(lines[index])) {
      const quoted = []
      let end = index
      while (end < lines.length && /^ {0,3}>/u.test(lines[end])) {
        quoted.push(lines[end].replace(/^ {0,3}>[ \t]?/u, ''))
        end += 1
      }
      const inner = message()
      quoted.forEach((line, lineIndex) => {
        if (lineIndex) append(inner, '\n')
        append(inner, renderInline(line))
      })
      rendered = styled('blockquote', inner)
      consumed = end - index
    } else rendered = renderLine(lines[index])
    append(output, rendered)
    index += consumed
    if (index < lines.length) append(output, '\n')
  }
  if (!output.text && source) return message(source)
  output.entities = normalizeEntities(output.text, output.entities)
  return output
}

function safeBoundary(text, candidate, minimum) {
  let boundary = Math.max(minimum, candidate)
  if (boundary > minimum && boundary < text.length && /[\uD800-\uDBFF]/u.test(text[boundary - 1]) && /[\uDC00-\uDFFF]/u.test(text[boundary])) boundary -= 1
  return boundary
}

function textBoundary(text, start, maximum) {
  if (maximum >= text.length) return text.length
  const minimum = start + Math.floor((maximum - start) / 2)
  let boundary = text.lastIndexOf('\n\n', maximum - 2)
  if (boundary >= minimum) return safeBoundary(text, boundary + 2, start + 1)
  boundary = text.lastIndexOf('\n', maximum - 1)
  if (boundary >= minimum) return safeBoundary(text, boundary + 1, start + 1)
  boundary = text.lastIndexOf(' ', maximum - 1)
  if (boundary >= minimum) return safeBoundary(text, boundary + 1, start + 1)
  return safeBoundary(text, maximum, start + 1)
}

function overlapping(entities, start, end) {
  return entities.filter(entity => entity.offset < end && entity.offset + entity.length > start)
}

export function splitTelegramMessage(rendered, { maxLength = TELEGRAM_TEXT_LIMIT, maxEntities = TELEGRAM_ENTITY_LIMIT } = {}) {
  if (!rendered.text) return [message()]
  if (!Number.isInteger(maxLength) || maxLength < 1 || !Number.isInteger(maxEntities) || maxEntities < 1) throw new Error('Telegram split limits must be positive integers')
  const chunks = []
  let start = 0
  while (start < rendered.text.length) {
    let end = textBoundary(rendered.text, start, Math.min(rendered.text.length, start + maxLength))
    let entities = overlapping(rendered.entities, start, end)
    if (entities.length > maxEntities) {
      const starts = [...new Set(entities.map(entity => entity.offset).filter(offset => offset > start))].sort((a, b) => a - b)
      for (const candidate of starts.reverse()) {
        const limitedEnd = safeBoundary(rendered.text, candidate, start + 1)
        if (overlapping(rendered.entities, start, limitedEnd).length <= maxEntities) { end = limitedEnd; break }
      }
      entities = overlapping(rendered.entities, start, end)
    }
    const chunkEntities = entities.slice(0, maxEntities).map(entity => {
      const offset = Math.max(start, entity.offset)
      const entityEnd = Math.min(end, entity.offset + entity.length)
      return { ...entity, offset: offset - start, length: entityEnd - offset }
    }).filter(entity => entity.length > 0)
    chunks.push(message(rendered.text.slice(start, end), chunkEntities))
    start = end
  }
  return chunks
}

export function formatTelegramMarkdown(markdown, options) {
  return splitTelegramMessage(renderTelegramMarkdown(markdown), options)
}
